import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';

async function start(context, dataDir) {
  const server = await createServer({ dataDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    request: async (method, url, body, headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await response.json().catch(() => ({}));
      return { status: response.status, json };
    },
  };
}

test('未认证请求被拒绝；事件按角色授权', async (context) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dendro-http-'));
  context.after(async () => rm(dir, { recursive: true, force: true }));
  const { request } = await start(context, dir);

  let res = await request('POST', '/v1/events', {
    type: 'mother_registered', batchId: 'M-1', label: 'T-1', baseId: 'B', quantity: 1,
  });
  assert.equal(res.status, 401);

  // 农户不能登记母本
  res = await request('POST', '/v1/events', {
    type: 'mother_registered', batchId: 'M-1', label: 'T-1', baseId: 'B', quantity: 1,
  }, { 'x-user-id': 'u1', 'x-user-role': 'farmer' });
  assert.equal(res.status, 403);

  // 研究人员可以
  res = await request('POST', '/v1/events', {
    type: 'mother_registered', batchId: 'M-1', label: 'T-1', baseId: 'B', quantity: 1,
  }, { 'x-user-id': 'u1', 'x-user-role': 'researcher' });
  assert.equal(res.status, 201);
  assert.equal(res.json.deduplicated, false);

  // 标签重复
  res = await request('POST', '/v1/events', {
    type: 'mother_registered', batchId: 'M-2', label: 'T-1', baseId: 'B', quantity: 1,
  }, { 'x-user-id': 'u1', 'x-user-role': 'researcher' });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'label_duplicate');
});

test('研究数据与农户联系方式分权可见，联系方式脱敏', async (context) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dendro-http-'));
  context.after(async () => rm(dir, { recursive: true, force: true }));
  const { request } = await start(context, dir);

  await request('POST', '/v1/events', {
    type: 'mother_registered', batchId: 'M-1', label: 'T-1', baseId: 'BASE-A', quantity: 1,
  }, { 'x-user-id': 'r1', 'x-user-role': 'researcher' });

  // 研究记录
  let res = await request('POST', '/v1/mothers/M-1/research-notes', {
    content: '野生曲茎石斛母本，海拔 1200m 栎树林附生',
  }, { 'x-user-id': 'r1', 'x-user-role': 'researcher' });
  assert.equal(res.status, 201);

  res = await request('GET', '/v1/mothers/M-1/research-notes', undefined, {
    'x-user-id': 'i1', 'x-user-role': 'inspector',
  });
  assert.equal(res.status, 403);

  res = await request('GET', '/v1/mothers/M-1/research-notes', undefined, {
    'x-user-id': 'r2', 'x-user-role': 'researcher',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.notes.length, 1);

  // 联系方式
  res = await request('POST', '/v1/contacts', {
    farmerId: 'F-1', name: '杨某', phone: '13800000001', baseId: 'BASE-A', siteIds: ['W-1'],
  }, { 'x-user-id': 'c1', 'x-user-role': 'coordinator' });
  assert.equal(res.status, 201);

  // 跨基地操作员无权登记
  res = await request('POST', '/v1/contacts', {
    farmerId: 'F-2', name: '王某', phone: '13800000002', baseId: 'BASE-A',
  }, { 'x-user-id': 'o1', 'x-user-role': 'base_operator', 'x-base-id': 'BASE-B' });
  assert.equal(res.status, 403);

  // 同基地操作员可见明文
  res = await request('GET', '/v1/contacts?ids=F-1', undefined, {
    'x-user-id': 'o2', 'x-user-role': 'base_operator', 'x-base-id': 'BASE-A',
  });
  assert.equal(res.json.contacts[0].phone, '13800000001');

  // 研究员反查时只看到脱敏编号
  res = await request('GET', '/v1/contacts?ids=F-1', undefined, {
    'x-user-id': 'r1', 'x-user-role': 'researcher',
  });
  assert.equal(res.json.contacts[0].phone, null);
  assert.equal(res.json.contacts[0].masked, true);
});

test('离线批量同步：整体成功，重复事件幂等；中途失败整体回滚', async (context) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dendro-http-'));
  context.after(async () => rm(dir, { recursive: true, force: true }));
  const { request } = await start(context, dir);
  const op = { 'x-user-id': 'o1', 'x-user-role': 'base_operator', 'x-base-id': 'BASE-A' };

  await request('POST', '/v1/events/batch', {
    events: [
      { type: 'mother_registered', batchId: 'M-1', label: 'T-1', baseId: 'BASE-A', quantity: 1, at: '2026-01-01T00:00:00.000Z' },
      {
        type: 'batch_germinated', batchId: 'S-1', label: 'T-2', motherBatchId: 'M-1',
        baseId: 'BASE-A', quantity: 100, at: '2026-03-01T00:00:00.000Z',
      },
    ],
  }, { 'x-user-id': 'c1', 'x-user-role': 'coordinator' });

  // 离线端重放同一批（带相同 eventId）→ 全部幂等
  const first = await request('GET', '/v1/events?limit=10', undefined, op);
  const ids = first.json.events.map((event) => event.eventId);
  const replay = await request('POST', '/v1/events/batch', {
    events: first.json.events.map((event) => ({ eventId: event.eventId, ...event })),
  }, { 'x-user-id': 'c1', 'x-user-role': 'coordinator' });
  assert.equal(replay.status, 201);
  assert.ok(replay.json.results.every((result) => result.deduplicated));

  // 非法批次（定植超量）→ 整体回滚，不产生任何新事件
  const before = await request('GET', '/v1/events?limit=100', undefined, op);
  const bad = await request('POST', '/v1/events/batch', {
    events: [
      {
        type: 'batch_split', parentBatchId: 'S-1',
        children: [{ batchId: 'S-1A', label: 'T-3', quantity: 40 }],
        at: '2026-03-02T00:00:00.000Z',
      },
      {
        type: 'planting_recorded', batchId: 'S-1', siteId: 'W-1', quantity: 999,
        at: '2026-03-03T00:00:00.000Z',
      },
    ],
  }, op);
  assert.equal(bad.status, 409);
  assert.equal(bad.json.error, 'insufficient_stock');
  const after = await request('GET', '/v1/events?limit=100', undefined, op);
  assert.equal(after.json.events.length, before.json.events.length, '失败批次不得留下事件');
  void ids;
});

test('端到端演练走 HTTP：拆分三处林地→补录不合格→召回去重通知→隔离→确认', async (context) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dendro-http-'));
  context.after(async () => rm(dir, { recursive: true, force: true }));
  const { request } = await start(context, dir);
  const coord = { 'x-user-id': 'c1', 'x-user-role': 'coordinator' };
  const insp = { 'x-user-id': 'i1', 'x-user-role': 'inspector' };

  await request('POST', '/v1/events/batch', {
    events: [
      { type: 'mother_registered', batchId: 'M-1', label: 'TAG-M1', baseId: 'BASE-A', quantity: 20, at: '2026-01-01T00:00:00.000Z' },
      {
        type: 'batch_germinated', batchId: 'S-1', label: 'TAG-S1', motherBatchId: 'M-1',
        baseId: 'BASE-A', quantity: 3000, medium: '松树皮', at: '2026-03-01T00:00:00.000Z',
      },
      {
        type: 'inspection_recorded', batchId: 'S-1', verdict: 'qualified',
        at: '2026-04-01T00:00:00.000Z',
      },
      {
        type: 'batch_split', parentBatchId: 'S-1',
        children: [
          { batchId: 'S-1A', label: 'TAG-A', quantity: 900 },
          { batchId: 'S-1B', label: 'TAG-B', quantity: 900 },
          { batchId: 'S-1C', label: 'TAG-C', quantity: 900 },
        ],
        at: '2026-04-05T00:00:00.000Z',
      },
      { type: 'planting_recorded', batchId: 'S-1A', siteId: 'WOOD-A', farmerId: 'F-1', quantity: 900, at: '2026-04-06T00:00:00.000Z' },
      { type: 'planting_recorded', batchId: 'S-1B', siteId: 'WOOD-B', farmerId: 'F-2', quantity: 900, at: '2026-04-07T00:00:00.000Z' },
      { type: 'planting_recorded', batchId: 'S-1C', siteId: 'WOOD-C', farmerId: 'F-1', quantity: 900, at: '2026-04-08T00:00:00.000Z' },
    ],
  }, coord);

  // 检测员离线补录：4 月 3 日的不合格结果，晚于定植才同步上来
  const late = await request('POST', '/v1/events', {
    type: 'inspection_recorded', batchId: 'S-1', verdict: 'unqualified',
    lab: '州林检中心', at: '2026-04-03T00:00:00.000Z',
  }, insp);
  assert.equal(late.status, 201);

  // 影响分析
  const impact = await request('GET', '/v1/impacts/S-1', undefined, coord);
  assert.equal(impact.status, 200);
  assert.deepEqual(impact.json.sites.map((s) => s.siteId).sort(), ['WOOD-A', 'WOOD-B', 'WOOD-C']);
  assert.deepEqual(impact.json.recipients.farmers.sort(), ['F-1', 'F-2'], 'F-1 承包两处只通知一次');
  assert.equal(impact.json.remainingUsableQuantity, 300);

  // 发布召回并隔离
  const recall = await request('POST', '/v1/recalls', {
    recallId: 'R-1', triggerBatchId: 'S-1', reason: '镰刀菌阳性补录', quarantine: true,
  }, coord);
  assert.equal(recall.status, 201);
  assert.deepEqual(recall.json.notified.sort(), ['base:BASE-A', 'farmer:F-1', 'farmer:F-2']);
  assert.equal(recall.json.quarantineEvents.length, 1);

  // 母批 300 株已全部隔离，可用量清零
  const impact2 = await request('GET', '/v1/impacts/S-1', undefined, coord);
  assert.equal(impact2.json.remainingUsableQuantity, 0);

  // 召回状态与逐点确认
  let status = await request('GET', '/v1/recalls/R-1', undefined, coord);
  assert.equal(status.json.pendingExecutions.length, 4, '三处站点 + 母批在库已隔离但仍需处置确认');
  for (const target of ['WOOD-A', 'WOOD-B', 'WOOD-C']) {
    const ack = await request('POST', `/v1/recalls/R-1/acknowledge`, { targetType: 'site', targetId: target }, coord);
    assert.equal(ack.status, 201);
  }
  await request('POST', '/v1/recalls/R-1/acknowledge', { targetType: 'batch', targetId: 'S-1' }, coord);
  status = await request('GET', '/v1/recalls/R-1', undefined, coord);
  assert.deepEqual(status.json.pendingExecutions, []);

  // 反查母本链
  const traceBack = await request('GET', '/v1/batches/S-1C/trace', undefined, coord);
  assert.equal(traceBack.json.motherBatchId, 'M-1');
  assert.ok(traceBack.json.chain.some((event) => event.type === 'batch_split'));
  assert.ok(traceBack.json.distributions.some((d) => d.siteId === 'WOOD-C'));
});

test('服务重启后事件链与分区数据完整恢复', async (context) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dendro-http-'));
  context.after(async () => rm(dir, { recursive: true, force: true }));
  const coord = { 'x-user-id': 'c1', 'x-user-role': 'coordinator' };

  {
    const { request } = await start(context, dir);
    await request('POST', '/v1/events', {
      type: 'mother_registered', batchId: 'M-1', label: 'T-1', baseId: 'B', quantity: 1,
    }, coord);
    await request('POST', '/v1/contacts', { farmerId: 'F-9', name: '吴某', phone: '13900000009', baseId: 'B' }, coord);
  }
  // 等待端口关闭后用同一数据目录重启（after 钩子在测试结束才关，这里直接新建实例读同一目录）
  const { request } = await start(context, dir);
  const batches = await request('GET', '/v1/batches', undefined, coord);
  assert.equal(batches.json.batches.length, 1);
  assert.equal(batches.json.batches[0].label, 'T-1');
  const contacts = await request('GET', '/v1/contacts?ids=F-9', undefined, coord);
  assert.equal(contacts.json.contacts[0].name, '吴某');
});
