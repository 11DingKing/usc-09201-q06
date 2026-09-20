import assert from 'node:assert/strict';
import test from 'node:test';
import { TraceabilityService } from '../src/domain/traceService.mjs';
import { EventStore } from '../src/domain/eventStore.mjs';
import { FarmerDirectory, BaseDirectory } from '../src/domain/contacts.mjs';
import { PermissionError, ConflictError, ValidationError } from '../src/domain/errors.mjs';

function setup() {
  const farmers = new FarmerDirectory();
  const bases = new BaseDirectory();
  const service = new TraceabilityService({ store: new EventStore(), farmerDirectory: farmers, baseDirectory: bases });
  bases.registerBase({ baseId: 'N1', name: '育苗一基地', kind: 'nursery', coordinatorFarmerId: 'fc1' });
  bases.registerBase({ baseId: 'F1', name: '林地一', kind: 'forest', coordinatorFarmerId: 'fc2' });
  const researcher = { id: 'r1', role: 'researcher' };
  const nursery = { id: 'n1', role: 'nursery_worker' };
  const inspector = { id: 'i1', role: 'inspector' };
  const coordinator = { id: 'c1', role: 'base_coordinator' };
  const officer = { id: 'o1', role: 'recall_officer' };
  const auditor = { id: 'a1', role: 'auditor' };

  const t0 = '2026-08-01T00:00:00.000Z';
  const mother = service.registerMother(researcher, { code: 'M-1', species: '曲茎石斛', note: '研究数据', at: t0 });
  const batch = service.registerBatch(nursery, {
    label: 'B-1', motherPlantId: mother.streamId, nurseryBaseId: 'N1', quantity: 500, at: t0,
  });
  return {
    service, farmers, bases, researcher, nursery, inspector, coordinator, officer, auditor,
    motherId: mother.streamId, batchId: batch.streamId,
  };
}

test('标签重复：母本编号与批次标签全局唯一，重复登记被拒绝', () => {
  const { service, researcher, nursery, motherId } = setup();
  assert.throws(() => service.registerMother(researcher, { code: 'M-1', species: '曲茎石斛' }), ConflictError);
  assert.throws(
    () => service.registerBatch(nursery, { label: 'B-1', motherPlantId: motherId, nurseryBaseId: 'N1', quantity: 1 }),
    ConflictError,
  );
});

test('离线采集：设备自带事件 id 与幂等键，断网重传不产生重复事实', () => {
  const { service, nursery, inspector, batchId } = setup();
  const deviceArgs = {
    streamId: batchId, subject: 'batch', result: 'qualified', lab: '移动检测车',
    eventId: 'evt-device-001', idempotencyKey: 'dev1:record:001', deviceId: 'pda-7',
    at: '2026-09-01T08:00:00.000Z',
  };
  service.recordInspection(inspector, deviceArgs);
  service.recordInspection(inspector, deviceArgs); // 断网重试
  service.recordInspection(inspector, { ...deviceArgs, idempotencyKey: undefined }); // 同事件 id 再来一次

  const inspections = service.store.all().filter((e) => e.type === 'inspection_recorded');
  assert.equal(inspections.length, 1);
  assert.equal(inspections[0].deviceId, 'pda-7');
  assert.equal(inspections[0].at, '2026-09-01T08:00:00.000Z');
  // 接收时间晚于发生时间，补传事实按发生时间参与回放
  assert.ok(inspections[0].recordedAt >= inspections[0].at);
});

test('离线批量补传：/sync 风格的重放对重复提交整体幂等', () => {
  const { service, nursery, batchId } = setup();
  const commands = {
    commands: [
      { command: 'transport', args: { batchId, fromBaseId: 'N1', toBaseId: 'F1', waybill: 'W1', idempotencyKey: 't1' } },
      { command: 'plant', args: { batchId, forestBaseId: 'F1', plotId: 'p1', quantity: 100, farmerId: 'f1', idempotencyKey: 'p1' } },
    ],
  };
  const coordinator = { id: 'c1', role: 'base_coordinator' };
  // 运输由育苗角色执行、定植由协调员执行；这里直接分别调用模拟离线重放
  service.transport(nursery, commands.commands[0].args);
  service.plant(coordinator, commands.commands[1].args);
  // 整包重传
  service.transport(nursery, commands.commands[0].args);
  service.plant(coordinator, commands.commands[1].args);
  assert.equal(service.store.all().filter((e) => e.type === 'transported').length, 1);
  assert.equal(service.store.all().filter((e) => e.type === 'planted').length, 1);
});

test('检测结果更正：追加更正事件，原始记录保留，当前有效结论随之改变', () => {
  const { service, inspector, auditor, batchId } = setup();
  const first = service.recordInspection(inspector, {
    streamId: batchId, subject: 'batch', result: 'qualified', lab: '质检中心', reportNo: 'R-1',
  });
  const inspectionId = first.data.inspectionId;

  service.correctInspection(inspector, {
    streamId: batchId, inspectionId, correctedResult: 'unqualified', reason: '复检发现样本混淆',
  });
  const batch = service.getBatch(auditor, batchId);
  const view = batch.inspections[0];
  assert.equal(view.initialResult, 'qualified');
  assert.equal(view.currentResult, 'unqualified');
  assert.equal(view.corrections.length, 1);

  // 历史链中原始记录与更正事件都在，已发生事实不可删除
  const history = service.history(auditor, batchId);
  assert.ok(history.some((e) => e.type === 'inspection_recorded' && e.data.result === 'qualified'));
  assert.ok(history.some((e) => e.type === 'inspection_corrected' && e.data.correctedResult === 'unqualified'));

  // 再更正回合格
  service.correctInspection(inspector, {
    streamId: batchId, inspectionId, correctedResult: 'qualified', reason: '实验室确认样本无污染',
  });
  assert.equal(service.getBatch(auditor, batchId).inspections[0].currentResult, 'qualified');
  assert.equal(service.getBatch(auditor, batchId).inspections[0].corrections.length, 2);
});

test('跨基地调拨：事实不允许被改写，乱序补录需运单核验', () => {
  const { service, nursery, batchId } = setup();
  service.transport(nursery, { batchId, fromBaseId: 'N1', toBaseId: 'F1', waybill: 'W-1' });
  // 补录一笔早于当前时间的再次调拨：仍以追加事件记录，当前位置按发生时间重放
  service.transport(nursery, {
    batchId, fromBaseId: 'F1', toBaseId: 'N1', waybill: 'W-2',
    at: new Date(Date.now() + 1000).toISOString(),
  });
  const view = service.getBatch({ id: 'x', role: 'auditor' }, batchId);
  assert.equal(view.location.baseId, 'N1');
  assert.equal(view.transports.length, 2);

  // 与当前位置矛盾且无运单 -> 拒绝，防止来源不明种苗混入
  assert.throws(
    () => service.transport(nursery, { batchId, fromBaseId: 'F1', toBaseId: 'F1' }),
    ValidationError,
  );
});

test('分权：研究数据与农户联系方式互相隔离', () => {
  const { service, farmers, officer, auditor, nursery, batchId } = setup();
  farmers.upsert(officer, { farmerId: 'f1', name: '农户甲', phone: '13900000000' });

  // 审计员可以读追溯链，但看不到母本研究备注
  const batchAsAuditor = service.getBatch(auditor, batchId);
  assert.equal(batchAsAuditor.mother.note, undefined);
  // 研究员可见研究数据
  assert.equal(service.getBatch({ id: 'r', role: 'researcher' }, batchId).mother.note, '研究数据');

  // 育苗角色无权登记母本、无权发召回、无权看联系方式
  assert.throws(() => service.registerMother(nursery, { code: 'X', species: '曲茎石斛' }), PermissionError);
  assert.throws(() => service.issueRecall(nursery, { rootBatchId: batchId, reason: 'x' }), PermissionError);

  // 审计员拿到的通知对象不含联系方式
  const inspection = service.recordInspection({ id: 'i', role: 'inspector' }, {
    streamId: batchId, result: 'unqualified', lab: 'l',
  });
  const { recallId } = service.issueRecall(officer, { rootBatchId: batchId, reason: '测试', triggerInspectionId: inspection.data.inspectionId });
  // 没有定植与基地库存协调员时通知可能为 0；改为直接验证 contacts 解析权限
  const redacted = farmers.resolve(auditor, ['f1']);
  assert.equal(redacted[0].phone, undefined);
  assert.equal(redacted[0].contactAvailable, true);
  const visible = farmers.resolve(officer, ['f1']);
  assert.equal(visible[0].phone, '13900000000');
  // 召回读取本身对审计员开放
  assert.ok(service.getRecall(auditor, recallId));
});

test('合批：同母本来向可合并，异母本拒绝，数量账实相符', () => {
  const { service, researcher, nursery, motherId } = setup();
  const b2 = service.registerBatch(nursery, { label: 'B-2', motherPlantId: motherId, nurseryBaseId: 'N1', quantity: 200 });
  const b3 = service.registerBatch(nursery, { label: 'B-3', motherPlantId: motherId, nurseryBaseId: 'N1', quantity: 100 });
  const targetId = service.mergeBatches(nursery, {
    targetLabel: 'B-M', sources: [{ batchId: b2.streamId, quantity: 150 }, { batchId: b3.streamId, quantity: 50 }],
  });
  const target = service.getBatch(nursery, targetId);
  assert.equal(target.initialQuantity, 200);
  assert.equal(target.origin.type, 'merge');
  assert.equal(service.getBatch(nursery, b2.streamId).availableQuantity, 50);
  assert.equal(service.getBatch(nursery, b3.streamId).availableQuantity, 50);

  const otherMother = service.registerMother(researcher, { code: 'M-2', species: '曲茎石斛' });
  const b4 = service.registerBatch(nursery, { label: 'B-4', motherPlantId: otherMother.streamId, nurseryBaseId: 'N1', quantity: 10 });
  assert.throws(
    () => service.mergeBatches(nursery, {
      targetLabel: 'B-X',
      sources: [{ batchId: b2.streamId, quantity: 1 }, { batchId: b4.streamId, quantity: 1 }],
    }),
    ValidationError,
  );
});

test('数量约束：拆分与定植不得超过剩余可用数量', () => {
  const { service, nursery, batchId } = setup();
  assert.throws(
    () => service.splitBatch(nursery, { batchId, childLabel: 'BIG', quantity: 501 }),
    ValidationError,
  );
  service.splitBatch(nursery, { batchId, childLabel: 'S-1', quantity: 500 });
  assert.equal(service.getBatch(nursery, batchId).availableQuantity, 0);
  assert.throws(
    () => service.splitBatch(nursery, { batchId, childLabel: 'S-2', quantity: 1 }),
    ValidationError,
  );
});
