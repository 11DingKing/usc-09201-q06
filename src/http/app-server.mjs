import http from 'node:http';
import { DomainError } from '../domain/errors.mjs';

const JSON_TYPES = new Set(['POST', 'PUT', 'PATCH']);

function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

// 纯函数式路由注册，避免引入框架依赖。
export function createAppServer(app) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const names = [];
    const source = pattern.replace(/:([^/]+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
    routes.push({ method, regexp: new RegExp(`^${source}$`), names, handler });
  };

  route('GET', '/health', async () => ({ status: 'ok' }));

  route('POST', '/v1/events', async (request, body, app) => {
    const actor = app.actorFrom(request.headers);
    const result = await app.appendEvent(body, actor);
    return { status: 201, body: result };
  });

  route('POST', '/v1/events/batch', async (request, body, app) => {
    const actor = app.actorFrom(request.headers);
    const results = await app.appendBatch(body.events ?? body, actor);
    return {
      status: 201,
      body: {
        count: results.length,
        results: results.map(({ event, deduplicated }) => ({ eventId: event.eventId, deduplicated })),
      },
    };
  });

  route('GET', '/v1/events', async (request, _body, app) => {
    const actor = app.actorFrom(request.headers);
    void actor; // 已认证即可读事件链（事件体内不含联系方式等敏感分区数据）
    const url = new URL(request.url, 'http://local');
    const fromSeq = Number(url.searchParams.get('fromSeq') ?? 0);
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 1000);
    return { events: app.ledger.listEvents({ fromSeq, limit }) };
  });

  route('GET', '/v1/batches', async (request, _body, app) => {
    const actor = app.actorFrom(request.headers);
    const url = new URL(request.url, 'http://local');
    let batches = app.ledger.listBatches();
    const baseId = url.searchParams.get('baseId');
    if (baseId) batches = batches.filter((batch) => batch.currentBaseId === baseId);
    return {
      batches: batches.map((batch) => app.batchView(batch.batchId, actor)),
    };
  });

  route('GET', '/v1/batches/:id', async (request, _body, app, params) => {
    const actor = app.actorFrom(request.headers);
    const batch = app.batchView(params.id, actor);
    if (!batch) return { status: 404, body: { error: 'not_found' } };
    return batch;
  });

  route('GET', '/v1/batches/:id/trace', async (request, _body, app, params) => {
    const actor = app.actorFrom(request.headers);
    const result = app.trace.traceBack(params.id);
    // 研究数据仅研究人员可见：无权限时从反查结果中剥离 nursing 细项中的研究字段。
    if (actor.role !== 'researcher' && actor.role !== 'coordinator') {
      result.nursing = result.nursing
        ? { batchId: result.nursing.batchId, baseId: result.nursing.baseId, germinatedAt: result.nursing.germinatedAt }
        : null;
    }
    return result;
  });

  route('GET', '/v1/batches/:id/inspections', async (request, _body, app, params) => {
    const actor = app.actorFrom(request.headers);
    void actor;
    return {
      batchId: params.id,
      effective: app.ledger.effectiveInspection(params.id),
      history: app.ledger.inspectionHistory(params.id),
    };
  });

  route('GET', '/v1/impacts/:batchId', async (request, _body, app, params) => {
    const actor = app.actorFrom(request.headers);
    const plan = app.trace.impactPlan(params.batchId);
    return withContactViews(plan, app, actor);
  });

  route('POST', '/v1/recalls', async (request, body, app) => {
    const actor = app.actorFrom(request.headers);
    const at = body.at ?? new Date().toISOString();
    const issued = app.trace.issueRecall(body.triggerBatchId, {
      recallId: body.recallId,
      reason: body.reason,
      severity: body.severity,
      actor,
      at,
    });
    let quarantineEvents = [];
    if (body.quarantine) {
      quarantineEvents = app.trace.quarantineImpact(body.triggerBatchId, {
        reason: body.reason,
        actor,
        at,
      });
    }
    return {
      status: 201,
      body: {
        recall: withContactViews({ ...issued.plan, recallId: body.recallId }, app, actor),
        notified: issued.notifications.map((event) => event.scopeKey),
        skippedDuplicates: issued.skippedDuplicates,
        quarantineEvents: quarantineEvents.map((event) => event.eventId),
      },
    };
  });

  route('POST', '/v1/recalls/:id/expand', async (request, body, app, params) => {
    const actor = app.actorFrom(request.headers);
    const result = app.trace.expandRecall(params.id, { actor, at: body.at ?? new Date().toISOString() });
    return {
      status: 201,
      body: {
        added: result.added.map((event) => event.scopeKey),
        alreadyNotified: result.alreadyNotified,
        plan: withContactViews(result.plan, app, actor),
      },
    };
  });

  route('POST', '/v1/recalls/:id/acknowledge', async (request, body, app, params) => {
    const actor = app.actorFrom(request.headers);
    const result = app.trace.acknowledge(params.id, body.targetType, body.targetId, {
      actor,
      at: body.at ?? new Date().toISOString(),
    });
    return { status: 201, body: { eventId: result.event.eventId, deduplicated: result.deduplicated } };
  });

  route('GET', '/v1/recalls/:id', async (request, _body, app, params) => {
    const actor = app.actorFrom(request.headers);
    void actor;
    return app.trace.recallStatus(params.id);
  });

  route('POST', '/v1/contacts', async (request, body, app) => {
    const actor = app.actorFrom(request.headers);
    const record = await app.upsertContact(body, actor);
    return { status: 201, body: record };
  });

  route('GET', '/v1/contacts', async (request, _body, app) => {
    const actor = app.actorFrom(request.headers);
    const url = new URL(request.url, 'http://local');
    const ids = (url.searchParams.get('ids') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    return { contacts: app.viewContacts(actor, ids) };
  });

  route('POST', '/v1/mothers/:id/research-notes', async (request, body, app, params) => {
    const actor = app.actorFrom(request.headers);
    const note = await app.putResearchNote(params.id, body, actor);
    return { status: 201, body: note };
  });

  route('GET', '/v1/mothers/:id/research-notes', async (request, _body, app, params) => {
    const actor = app.actorFrom(request.headers);
    return { notes: app.listResearchNotes(params.id, actor) };
  });

  function withContactViews(plan, app, actor) {
    const contacts = app.viewContacts(actor, plan.recipients?.farmers ?? []);
    return { ...plan, contactViews: contacts };
  }

  return http.createServer(async (request, response) => {
    try {
      let body = null;
      if (JSON_TYPES.has(request.method)) {
        const raw = await readBody(request);
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            return send(response, 400, { error: 'invalid_json' });
          }
        }
      }
      for (const candidate of routes) {
        if (candidate.method !== request.method) continue;
        const pathname = new URL(request.url, 'http://local').pathname;
        const match = candidate.regexp.exec(pathname);
        if (!match) continue;
        const params = Object.fromEntries(candidate.names.map((name, i) => [name, match[i + 1]]));
        const result = await candidate.handler(request, body, app, params);
        if (result?.status !== undefined && result.body !== undefined) {
          return send(response, result.status, result.body);
        }
        return send(response, 200, result);
      }
      return send(response, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof DomainError) {
        return send(response, error.status, { error: error.code, message: error.message });
      }
      console.error(error);
      return send(response, 500, { error: 'internal_error', message: error.message });
    }
  });
}

function readBody(request, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new DomainError('请求体过大', 'payload_too_large', 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
