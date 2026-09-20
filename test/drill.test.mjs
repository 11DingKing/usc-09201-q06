import assert from 'node:assert/strict';
import test from 'node:test';
import { TraceabilityService } from '../src/domain/traceService.mjs';
import { EventStore } from '../src/domain/eventStore.mjs';
import { FarmerDirectory, BaseDirectory } from '../src/domain/contacts.mjs';
import { PermissionError, ConflictError } from '../src/domain/errors.mjs';

// 季末演练：一个育苗批拆给三处林地定植，之后补录不合格检测，
// 核对影响范围、通知对象与剩余可用数量，并验证定向召回与通知去重。
function setupDrill() {
  const farmers = new FarmerDirectory();
  const bases = new BaseDirectory();
  const service = new TraceabilityService({ store: new EventStore(), farmerDirectory: farmers, baseDirectory: bases });

  const researcher = { id: 'u-research', role: 'researcher' };
  const nursery = { id: 'u-nursery', role: 'nursery_worker' };
  const inspector = { id: 'u-inspector', role: 'inspector' };
  const coordinator = { id: 'u-coord', role: 'base_coordinator' };
  const officer = { id: 'u-officer', role: 'recall_officer' };

  // 基地与协调员
  bases.registerBase({ baseId: 'NURSERY-1', name: '曲茎石斛育苗中心', kind: 'nursery', coordinatorFarmerId: 'fc-nurs' });
  bases.registerBase({ baseId: 'FOREST-甲', name: '甲处林地', kind: 'forest', coordinatorFarmerId: 'fc-a' });
  bases.registerBase({ baseId: 'FOREST-乙', name: '乙处林地', kind: 'forest', coordinatorFarmerId: 'fc-b' });
  bases.registerBase({ baseId: 'FOREST-丙', name: '丙处林地', kind: 'forest', coordinatorFarmerId: 'fc-c' });

  for (const [farmerId, name] of [
    ['f-甲', '甲处农户'], ['f-乙', '乙处农户'], ['f-丙', '丙处农户'],
    ['fc-a', '甲处协调员'], ['fc-b', '乙处协调员'], ['fc-c', '丙处协调员'],
    ['fc-nurs', '育苗中心协调员'], ['f-无关', '无关农户'],
  ]) {
    farmers.upsert(officer, { farmerId, name, phone: `1380000${farmerId}` });
  }

  // 母本
  const mother = service.registerMother(researcher, {
    code: 'DEN-FLEX-001', species: '曲茎石斛', source: '原产地野生居群',
    locationBaseId: 'NURSERY-1', note: '研究备注：多糖含量跟踪样本',
    at: '2026-05-01T00:00:00.000Z',
  });
  const motherId = mother.streamId;

  // 育苗批 3000 株
  const batch = service.registerBatch(nursery, {
    label: 'SEED-2026-0001', motherPlantId: motherId, nurseryBaseId: 'NURSERY-1', quantity: 3000,
    at: '2026-06-01T00:00:00.000Z',
  });
  return { service, farmers, bases, researcher, nursery, inspector, coordinator, officer, motherId, rootId: batch.streamId };
}

test('季末演练：拆批三处林地 → 补录不合格检测 → 定向召回', () => {
  const drill = setupDrill();
  const { service, nursery, inspector, officer, motherId } = drill;
  const rootId = drill.rootId;

  // 固定时间线：采样检验（结果滞后）-> 拆分定植 -> 季末补录结果
  const tSample = '2026-06-10T00:00:00.000Z';
  const tDispatch = '2026-07-01T00:00:00.000Z';

  // 拆给三处林地：1000 / 1000 / 500，父批剩余 500
  const c1 = service.splitBatch(nursery, { batchId: rootId, childLabel: 'SEED-2026-0001-A', quantity: 1000, at: tDispatch });
  const c2 = service.splitBatch(nursery, { batchId: rootId, childLabel: 'SEED-2026-0001-B', quantity: 1000, at: tDispatch });
  const c3 = service.splitBatch(nursery, { batchId: rootId, childLabel: 'SEED-2026-0001-C', quantity: 500, at: tDispatch });
  const c1Id = c1.childBatchId;
  const c2Id = c2.childBatchId;
  const c3Id = c3.childBatchId;

  // 跨基地调拨到三处林地
  service.transport(nursery, { batchId: c1Id, fromBaseId: 'NURSERY-1', toBaseId: 'FOREST-甲', waybill: 'WB-A', at: tDispatch });
  service.transport(nursery, { batchId: c2Id, fromBaseId: 'NURSERY-1', toBaseId: 'FOREST-乙', waybill: 'WB-B', at: tDispatch });
  service.transport(nursery, { batchId: c3Id, fromBaseId: 'NURSERY-1', toBaseId: 'FOREST-丙', waybill: 'WB-C', at: tDispatch });

  // 仿野生定植
  service.plant({ id: 'coord-a', role: 'base_coordinator' }, { batchId: c1Id, forestBaseId: 'FOREST-甲', plotId: 'plot-甲', quantity: 1000, farmerId: 'f-甲', at: '2026-07-05T00:00:00.000Z' });
  service.plant({ id: 'coord-b', role: 'base_coordinator' }, { batchId: c2Id, forestBaseId: 'FOREST-乙', plotId: 'plot-乙', quantity: 1000, farmerId: 'f-乙', at: '2026-07-05T00:00:00.000Z' });
  service.plant({ id: 'coord-c', role: 'base_coordinator' }, { batchId: c3Id, forestBaseId: 'FOREST-丙', plotId: 'plot-丙', quantity: 500, farmerId: 'f-丙', at: '2026-07-05T00:00:00.000Z' });

  // 无关批次：定植在第四处林地，不应被召回波及
  const other = service.registerBatch(nursery, { label: 'SEED-2026-9999', motherPlantId: motherId, nurseryBaseId: 'NURSERY-1', quantity: 100 });
  service.transport(nursery, { batchId: other.streamId, fromBaseId: 'NURSERY-1', toBaseId: 'FOREST-甲', waybill: 'WB-X' });
  service.plant({ id: 'coord-a', role: 'base_coordinator' }, { batchId: other.streamId, forestBaseId: 'FOREST-甲', plotId: 'plot-无关', quantity: 100, farmerId: 'f-无关' });

  // 季末补录：6 月采样的检测到 9 月才出具不合格结论（发生时间在登记之后，补录合法）
  const inspection = service.recordInspection(inspector, {
    streamId: rootId, subject: 'batch', result: 'unqualified', lab: '联合体质检中心',
    reportNo: 'QR-2026-0091', at: tSample,
  });

  // 签发定向召回
  const { recallId, impact } = service.issueRecall(officer, {
    rootBatchId: rootId, reason: '补录不合格检测：疑似种源污染', triggerInspectionId: inspection.data.inspectionId,
  });

  // 1) 影响范围覆盖父批与三个拆分子批
  assert.deepEqual(impact.batchIds.sort(), [rootId, c1Id, c2Id, c3Id].sort());
  // 2) 三处林地各种植点
  assert.equal(impact.plots.length, 3);
  const plotNames = impact.plots.map((p) => p.plotId).sort();
  assert.deepEqual(plotNames, ['plot-丙', 'plot-乙', 'plot-甲']);
  // 3) 在田数量 2500，剩余可用 500（父批库存）
  assert.equal(impact.plantedQuantity, 2500);
  assert.equal(impact.remainingAvailableQuantity, 500);
  // 4) 三处受影响农户
  assert.deepEqual(impact.farmerIds.sort(), ['f-丙', 'f-乙', 'f-甲']);
  // 5) 无关批次、无关农户、无关地块均不在范围
  assert.ok(!impact.batchIds.includes(other.streamId));
  assert.ok(!impact.farmerIds.includes('f-无关'));

  // 召回通知：3 名农户 + 3 处林地协调员 + 1 名持有剩余库存的育苗中心协调员 = 7，去重
  const recall = service.getRecall(officer, recallId);
  assert.equal(recall.notificationCount, 7);
  const notified = recall.notifications.map((n) => n.recipientId).sort();
  assert.deepEqual(notified, ['f-丙', 'f-乙', 'f-甲', 'fc-a', 'fc-b', 'fc-c', 'fc-nurs'].sort());

  // 同一受影响链重复同步通知，不产生重复通知
  const before = service.store.all().length;
  service.syncRecallNotifications(officer, recallId);
  service.syncRecallNotifications(officer, recallId);
  assert.equal(service.getRecall(officer, recallId).notificationCount, 7);
  // 去重完全发生在追加层：没有写入任何新的通知事件
  const notificationEvents = service.store.all().filter((e) => e.type === 'notification_recorded');
  assert.equal(notificationEvents.length, 7);
  assert.equal(service.store.all().length, before);

  // 快照是签发时的固定留档
  assert.equal(recall.snapshot.plantedQuantity, 2500);
  assert.equal(recall.snapshot.remainingAvailableQuantity, 500);

  // 受影响批次全部隔离：父批剩余 500 株不得再出库定植
  const rootView = service.getBatch(officer, rootId);
  assert.equal(rootView.quarantined, true);
  assert.equal(rootView.availableQuantity, 500);
  for (const child of [c1Id, c2Id, c3Id]) {
    assert.equal(service.getBatch(officer, child).quarantined, true);
  }
  // 无关批次未被隔离
  assert.equal(service.getBatch(officer, other.streamId).quarantined, false);

  // 隔离批次禁止定植（用有定植权限的协调员，确保拦截原因是隔离而非角色）
  assert.throws(
    () => service.plant({ id: 'coord-a', role: 'base_coordinator' }, { batchId: rootId, forestBaseId: 'FOREST-甲', plotId: 'p', quantity: 10, farmerId: 'f-甲' }),
    (e) => e instanceof ConflictError,
  );

  // 反查母本链：从母本可向下游追踪到全部批次与去向
  const traced = service.trace(officer, rootId);
  assert.deepEqual(traced.downstream.map((b) => b.id).sort(), [c1Id, c2Id, c3Id].sort());

  // 演练结束关闭召回，隔离解除
  service.closeRecall(officer, recallId, '演练结束，解除隔离');
  assert.equal(service.getBatch(officer, rootId).quarantined, false);
  assert.ok(service.getRecall(officer, recallId).closedAt);
});
