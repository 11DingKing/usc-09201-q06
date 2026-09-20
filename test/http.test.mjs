import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/http/app.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(base, method, url, { body, actor } = {}) {
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (actor) {
    headers['x-actor-id'] = actor.id;
    headers['x-actor-role'] = actor.role;
  }
  const response = await fetch(`${base}${url}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return { status: response.status, json };
}

test('HTTP：健康检查与完整召回链路', async (context) => {
  const server = createApp();
  context.after(() => server.close());
  const base = await listen(server);

  const researcher = { id: 'r', role: 'researcher' };
  const nursery = { id: 'n', role: 'nursery_worker' };
  const inspector = { id: 'i', role: 'inspector' };
  const coordinator = { id: 'c', role: 'base_coordinator' };
  const officer = { id: 'o', role: 'recall_officer' };

  assert.equal((await request(base, 'GET', '/health')).status, 200);

  await request(base, 'POST', '/api/bases', { body: { baseId: 'N1', name: '育苗', kind: 'nursery', coordinatorFarmerId: 'fc' } });
  await request(base, 'POST', '/api/bases', { body: { baseId: 'F1', name: '林地', kind: 'forest', coordinatorFarmerId: 'fcc' } });
  await request(base, 'POST', '/api/farmers', { body: { farmerId: 'f1', name: '农户一', phone: '139' }, actor: officer });

  const mother = await request(base, 'POST', '/api/mothers', {
    body: { code: 'M1', species: '曲茎石斛', note: '研究备注' }, actor: researcher,
  });
  const batch = await request(base, 'POST', '/api/batches', {
    body: { label: 'B1', motherPlantId: mother.json.streamId, nurseryBaseId: 'N1', quantity: 100 }, actor: nursery,
  });

  // 标签重复 -> 409
  const dup = await request(base, 'POST', '/api/batches', {
    body: { label: 'B1', motherPlantId: mother.json.streamId, nurseryBaseId: 'N1', quantity: 1 }, actor: nursery,
  });
  assert.equal(dup.status, 409);

  // 越权 -> 403
  const denied = await request(base, 'POST', '/api/mothers', { body: { code: 'X', species: 'x' }, actor: nursery });
  assert.equal(denied.status, 403);

  const split = await request(base, 'POST', `/api/batches/${batch.json.streamId}/split`, {
    body: { childLabel: 'B1-A', quantity: 60 }, actor: nursery,
  });
  const childId = split.json.childBatchId;

  await request(base, 'POST', '/api/transports', {
    body: { batchId: childId, fromBaseId: 'N1', toBaseId: 'F1', waybill: 'W1' }, actor: nursery,
  });
  await request(base, 'POST', '/api/plantings', {
    body: { batchId: childId, forestBaseId: 'F1', plotId: 'p1', quantity: 60, farmerId: 'f1' }, actor: coordinator,
  });

  const inspection = await request(base, 'POST', '/api/inspections', {
    body: { streamId: batch.json.streamId, result: 'unqualified', lab: '质检中心' }, actor: inspector,
  });

  const recall = await request(base, 'POST', '/api/recalls', {
    body: {
      rootBatchId: batch.json.streamId,
      reason: '不合格',
      triggerInspectionId: inspection.json.data.inspectionId,
    },
    actor: officer,
  });
  assert.equal(recall.status, 200);
  assert.equal(recall.json.impact.plantedQuantity, 60);
  assert.equal(recall.json.impact.remainingAvailableQuantity, 40);
  // 农户 f1 + 林地协调 fcc + 育苗中心协调 fc（持有剩余 40 株）= 3
  assert.equal(recall.json.impact.farmerIds.length, 1);

  const recallView = await request(base, 'GET', `/api/recalls/${recall.json.recallId}`, { actor: officer });
  assert.equal(recallView.json.notificationCount, 3);
  // 召回管理员可见农户联系方式
  assert.ok(recallView.json.notifications.some((n) => n.recipientId === 'f1' && n.contact?.phone === '139'));

  // 审计员：通知对象联系方式脱敏
  const auditor = { id: 'a', role: 'auditor' };
  const audited = await request(base, 'GET', `/api/recalls/${recall.json.recallId}`, { actor: auditor });
  assert.ok(audited.json.notifications.every((n) => n.contact === 'redacted'));
  // 母本研究备注对审计员不可见
  const batchView = await request(base, 'GET', `/api/batches/${batch.json.streamId}`, { actor: auditor });
  assert.equal(batchView.json.mother.note, undefined);

  // 离线重放：相同幂等键不产生重复事实
  const payload = {
    commands: [{
      command: 'recordInspection',
      args: {
        streamId: batch.json.streamId, result: 'qualified', lab: '移动车',
        idempotencyKey: 'offline-1',
      },
    }],
  };
  await request(base, 'POST', '/api/offline/sync', { body: payload, actor: inspector });
  await request(base, 'POST', '/api/offline/sync', { body: payload, actor: inspector });
  const history = await request(base, 'GET', `/api/streams/${batch.json.streamId}/history`, { actor: auditor });
  // 离线整包重传两次，合格检验只落一条事实（连同早先的不合格检验共 2 条）
  assert.equal(history.json.filter((e) => e.type === 'inspection_recorded').length, 2);

  // 坏 JSON -> 400
  const bad = await fetch(`${base}/api/batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-actor-role': 'nursery_worker' },
    body: '{not-json',
  });
  assert.equal(bad.status, 400);
});
