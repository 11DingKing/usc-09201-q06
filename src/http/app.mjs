import http from 'node:http';
import { TraceabilityService } from '../domain/traceService.mjs';
import { FarmerDirectory, BaseDirectory } from '../domain/contacts.mjs';
import { EventStore } from '../domain/eventStore.mjs';
import { ValidationError, ConflictError, PermissionError, NotFoundError } from '../domain/errors.mjs';

const json = 'application/json; charset=utf-8';

export function createApp({ service } = {}) {
  const farmers = new FarmerDirectory();
  const bases = new BaseDirectory();
  const app = service ?? new TraceabilityService({
    store: new EventStore(),
    farmerDirectory: farmers,
    baseDirectory: bases,
  });

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---------- 母本 / 育苗批 ----------
  route('POST', /^\/api\/mothers$/, withBody((body, actor) => app.registerMother(actor, body)));
  route('POST', /^\/api\/batches$/, withBody((body, actor) => app.registerBatch(actor, body)));
  route('POST', /^\/api\/batches\/merge$/, withBody((body, actor) => app.mergeBatches(actor, body)));
  route('POST', /^\/api\/batches\/([^/]+)\/split$/, withBody((body, actor, match) =>
    app.splitBatch(actor, { ...body, batchId: match[1] })));
  route('GET', /^\/api\/batches\/([^/]+)$/, (_, actor, match) => app.getBatch(actor, match[1]));
  route('GET', /^\/api\/batches\/([^/]+)\/trace$/, (_, actor, match) => app.trace(actor, match[1]));

  // ---------- 检验 / 转运 / 定植 ----------
  route('POST', /^\/api\/inspections$/, withBody((body, actor) => app.recordInspection(actor, body)));
  route('POST', /^\/api\/inspections\/correct$/, withBody((body, actor) => app.correctInspection(actor, body)));
  route('POST', /^\/api\/transports$/, withBody((body, actor) => app.transport(actor, body)));
  route('POST', /^\/api\/plantings$/, withBody((body, actor) => app.plant(actor, body)));

  // ---------- 召回 ----------
  route('POST', /^\/api\/recalls$/, withBody((body, actor) => app.issueRecall(actor, body)));
  route('POST', /^\/api\/recalls\/([^/]+)\/sync-notifications$/, withBody((body, actor, match) =>
    app.syncRecallNotifications(actor, match[1], body.channels)));
  route('POST', /^\/api\/recalls\/([^/]+)\/close$/, withBody((body, actor, match) =>
    app.closeRecall(actor, match[1], body.reason)));
  route('GET', /^\/api\/recalls\/([^/]+)$/, (_, actor, match) => app.getRecall(actor, match[1]));

  // ---------- 事件链与通讯录 ----------
  route('GET', /^\/api\/streams\/([^/]+)\/history$/, (_, actor, match) => app.history(actor, match[1]));
  route('POST', /^\/api\/farmers$/, withBody((body, actor) => farmers.upsert(actor, body)));
  route('POST', /^\/api\/bases$/, withBody((body) => bases.registerBase(body)));

  // 离线采集补传：一组命令按顺序重放，幂等键保证重复提交不产生重复事实
  route('POST', /^\/api\/offline\/sync$/, withBody((body, actor) => {
    if (!Array.isArray(body.commands)) throw new ValidationError('commands 必须为数组');
    const results = [];
    for (const item of body.commands) {
      const handler = offlineHandlers[item.command];
      if (!handler) throw new ValidationError(`未知命令 ${item.command}`);
      results.push(handler(item.args ?? {}, actor));
    }
    return { replayed: results.length, results };
  }));

  const offlineHandlers = {
    registerBatch: (args, actor) => app.registerBatch(actor, args),
    recordInspection: (args, actor) => app.recordInspection(actor, args),
    transport: (args, actor) => app.transport(actor, args),
    plant: (args, actor) => app.plant(actor, args),
    splitBatch: (args, actor) => app.splitBatch(actor, args),
  };

  function withBody(fn) {
    return async (body, actor, match) => fn(body, actor, match);
  }

  return http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      send(response, 200, { status: 'ok' });
      return;
    }

    const url = new URL(request.url, 'http://localhost');
    const matchRoute = routes.find((r) => r.method === request.method && r.pattern.test(url.pathname));

    if (!matchRoute) {
      send(response, 404, { error: 'not_found' });
      return;
    }

    try {
      const actor = { id: request.headers['x-actor-id'] || 'anonymous', role: request.headers['x-actor-role'] || 'anonymous' };
      const body = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await readJson(request) : {};
      const result = await matchRoute.handler(body, actor, url.pathname.match(matchRoute.pattern));
      send(response, 200, result ?? { ok: true });
    } catch (error) {
      const status = error instanceof ValidationError ? 400
        : error instanceof PermissionError ? 403
        : error instanceof NotFoundError ? 404
        : error instanceof ConflictError ? 409
        : 500;
      if (status === 500) console.error(error);
      send(response, status, { error: error.code ?? 'internal_error', message: error.message });
    }
  });
}

function send(response, status, payload) {
  response.writeHead(status, { 'content-type': json });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('请求体不是合法 JSON');
  }
}
