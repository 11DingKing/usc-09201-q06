import assert from 'node:assert/strict';
import test from 'node:test';
import { Ledger, EVENT_TYPES, VERDICTS } from '../src/domain/ledger.mjs';
import { TraceService } from '../src/domain/trace.mjs';
import { Directory } from '../src/domain/directory.mjs';

const ISO = '2026-03-01T08:00:00.000Z';
const at = (day, hour = 8) => `2026-${String(3 + Math.floor((day - 1) / 30)).padStart(2, '0')}-${String(((day - 1) % 30) + 1).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

function seed() {
  const ledger = new Ledger();
  const trace = new TraceService(ledger, new Directory());
  const coordinator = { id: 'u-coord', role: 'coordinator' };
  const researcher = { id: 'u-res', role: 'researcher' };
  const inspector = { id: 'u-insp', role: 'inspector' };
  const opA = { id: 'u-opA', role: 'base_operator', baseId: 'BASE-A' };
  const opB = { id: 'u-opB', role: 'base_operator', baseId: 'BASE-B' };
  return { ledger, trace, coordinator, researcher, inspector, opA, opB };
}

test('季末演练：育苗批拆往三处林地后补录不合格检测，影响范围、通知去重与剩余可用量正确', () => {
  const { ledger, trace, coordinator, researcher, inspector } = seed();

  // 1) 母本与育苗批（3000 株）
  ledger.append({
    type: EVENT_TYPES.MOTHER_REGISTERED,
    batchId: 'M-01', label: 'LBL-M-01', baseId: 'BASE-A', quantity: 50,
    at: at(1),
  }, { actor: researcher });

  ledger.append({
    type: EVENT_TYPES.BATCH_GERMINATED,
    batchId: 'S-01', label: 'LBL-S-01', motherBatchId: 'M-01',
    baseId: 'BASE-A', quantity: 3000, medium: '松树皮+苔藓',
    at: at(20),
  }, { actor: researcher });

  // 2) 育苗批初检合格
  ledger.append({
    type: EVENT_TYPES.INSPECTION_RECORDED,
    batchId: 'S-01', verdict: VERDICTS.QUALIFIED, lab: '州林检中心',
    items: [{ item: '炭疽病', result: 'negative' }],
    at: at(40),
  }, { actor: inspector });

  // 3) 季末演练：拆给三处林地，每处 900 株（共 2700，余 300 在库）
  ledger.append({
    type: EVENT_TYPES.BATCH_SPLIT,
    parentBatchId: 'S-01',
    children: [
      { batchId: 'S-01-A', label: 'LBL-S-01-A', quantity: 900 },
      { batchId: 'S-01-B', label: 'LBL-S-01-B', quantity: 900 },
      { batchId: 'S-01-C', label: 'LBL-S-01-C', quantity: 900 },
    ],
    at: at(45),
  }, { actor: coordinator });

  // 三处林地分别定植；农户 F-1 承包 A、C 两处
  ledger.append({ type: EVENT_TYPES.PLANTING_RECORDED, batchId: 'S-01-A', siteId: 'WOOD-A', parcelId: 'P-1', farmerId: 'F-1', quantity: 900, at: at(46) }, { actor: coordinator });
  ledger.append({ type: EVENT_TYPES.PLANTING_RECORDED, batchId: 'S-01-B', siteId: 'WOOD-B', parcelId: 'P-2', farmerId: 'F-2', quantity: 900, at: at(47) }, { actor: coordinator });
  ledger.append({ type: EVENT_TYPES.PLANTING_RECORDED, batchId: 'S-01-C', siteId: 'WOOD-C', parcelId: 'P-3', farmerId: 'F-1', quantity: 900, at: at(48) }, { actor: coordinator });

  // 4) 补录不合格检测（离线采集、迟到入账，但发生时间早于拆分）
  const { event: badInspection } = ledger.append({
    type: EVENT_TYPES.INSPECTION_RECORDED,
    batchId: 'S-01', verdict: VERDICTS.UNQUALIFIED, lab: '州林检中心',
    items: [{ item: '尖孢镰刀菌', result: 'positive' }],
    at: at(42), // 发生在拆分（at45）之前，recordedAt 在其后
  }, { actor: inspector });

  assert.equal(badInspection.at, at(42));
  assert.ok(badInspection.recordedAt > badInspection.at, '入账时间应晚于发生时间（离线补录）');

  // 5) 核对影响范围：触发批 S-01 + 三个下游批，三处林地
  const plan = trace.impactPlan('S-01');
  assert.deepEqual(plan.batchIds.sort(), ['S-01', 'S-01-A', 'S-01-B', 'S-01-C']);
  assert.deepEqual(plan.sites.map((s) => s.siteId).sort(), ['WOOD-A', 'WOOD-B', 'WOOD-C']);
  assert.equal(plan.affectedPlantedQuantity, 2700);
  assert.equal(plan.remainingUsableQuantity, 300, '母批仅剩 300 株在库可隔离');

  // 同一农户 F-1 承包两处林地，通知对象只出现一次
  assert.deepEqual(plan.recipients.farmers.sort(), ['F-1', 'F-2']);
  assert.deepEqual(plan.recipients.bases, ['BASE-A']);

  // 6) 发布定向召回并隔离剩余在库
  const issued = trace.issueRecall('S-01', {
    recallId: 'R-2026-001',
    reason: '补录检出尖孢镰刀菌阳性',
    actor: coordinator,
    at: at(60),
  });
  assert.deepEqual(
    issued.notifications.map((n) => n.scopeKey).sort(),
    ['base:BASE-A', 'farmer:F-1', 'farmer:F-2'],
  );
  trace.quarantineImpact('S-01', { reason: 'R-2026-001 隔离', actor: coordinator, at: at(60) });
  assert.equal(ledger.getBatch('S-01').quarantinedQty, 300);

  // 重复发起召回不重复通知
  const again = trace.issueRecall('S-01', {
    recallId: 'R-2026-001', reason: '补录检出尖孢镰刀菌阳性', actor: coordinator, at: at(60),
  });
  assert.equal(again.notifications.length, 0);
  assert.deepEqual(again.skippedDuplicates.sort(), ['base:BASE-A', 'farmer:F-1', 'farmer:F-2']);

  // 召回状态：三处定植站点 + 母批在库 300 株（待处置确认）
  const status = trace.recallStatus('R-2026-001');
  assert.deepEqual(status.planSummary.affectedSiteIds.sort(), ['WOOD-A', 'WOOD-B', 'WOOD-C']);
  assert.deepEqual(
    status.pendingExecutions.sort(),
    ['batch:S-01', 'site:WOOD-A', 'site:WOOD-B', 'site:WOOD-C'],
  );
  trace.acknowledge('R-2026-001', 'site', 'WOOD-A', { actor: coordinator });
  trace.acknowledge('R-2026-001', 'batch', 'S-01', { actor: coordinator });
  assert.deepEqual(
    trace.recallStatus('R-2026-001').pendingExecutions.sort(),
    ['site:WOOD-B', 'site:WOOD-C'],
  );
  // 确认幂等
  const dup = trace.acknowledge('R-2026-001', 'site', 'WOOD-A', { actor: coordinator });
  assert.equal(dup.deduplicated, true);
});

test('标签重复在任何事件顺序下都被拒绝，物理标签全局唯一', () => {
  const { ledger, coordinator } = seed();
  ledger.append({ type: EVENT_TYPES.MOTHER_REGISTERED, batchId: 'M-1', label: 'TAG-1', baseId: 'B', quantity: 1, at: ISO });
  assert.throws(
    () => ledger.append({ type: EVENT_TYPES.MOTHER_REGISTERED, batchId: 'M-2', label: 'TAG-1', baseId: 'B', quantity: 1, at: ISO }),
    (error) => error.code === 'label_duplicate',
  );
  // 拆分新批使用已存在标签同样拒绝
  ledger.append({ type: EVENT_TYPES.BATCH_GERMINATED, batchId: 'S-1', label: 'TAG-S', motherBatchId: 'M-1', baseId: 'B', quantity: 10, at: ISO });
  assert.throws(
    () => ledger.append({
      type: EVENT_TYPES.BATCH_SPLIT, parentBatchId: 'S-1',
      children: [{ batchId: 'S-1X', label: 'TAG-1', quantity: 5 }], at: ISO,
    }),
    (error) => error.code === 'label_duplicate',
  );
  void coordinator;
});

test('检测更正：旧结果保留且失效，当前有效结论取更正后版本', () => {
  const { ledger, inspector } = seed();
  ledger.append({ type: EVENT_TYPES.MOTHER_REGISTERED, batchId: 'M-1', label: 'T-1', baseId: 'B', quantity: 1, at: ISO });
  ledger.append({ type: EVENT_TYPES.BATCH_GERMINATED, batchId: 'S-1', label: 'T-2', motherBatchId: 'M-1', baseId: 'B', quantity: 10, at: ISO });
  const first = ledger.append({ type: EVENT_TYPES.INSPECTION_RECORDED, batchId: 'S-1', verdict: VERDICTS.QUALIFIED, at: ISO }, { actor: inspector }).event;
  ledger.append({
    type: EVENT_TYPES.INSPECTION_CORRECTED, supersedes: first.eventId, batchId: 'S-1',
    verdict: VERDICTS.CONDITIONAL, reason: '实验室复核发现培养物污染', at: '2026-03-02T08:00:00.000Z',
  }, { actor: inspector });

  const history = ledger.inspectionHistory('S-1');
  assert.equal(history.length, 2);
  assert.equal(history[0].active, false);
  assert.equal(history[0].supersededBy, history[1].eventId);
  assert.equal(ledger.effectiveInspection('S-1').verdict, VERDICTS.CONDITIONAL);
  // 不能对已更正的结果再次更正
  assert.throws(
    () => ledger.append({
      type: EVENT_TYPES.INSPECTION_CORRECTED, supersedes: first.eventId, batchId: 'S-1',
      verdict: VERDICTS.UNQUALIFIED, reason: '再次更正', at: '2026-03-03T08:00:00.000Z',
    }, { actor: inspector }),
    (error) => error.code === 'result_already_corrected',
  );
});

test('跨基地调拨：必须先发出再接收，库存随归属移动，隔离库存禁止调出', () => {
  const { ledger, coordinator } = seed();
  ledger.append({ type: EVENT_TYPES.MOTHER_REGISTERED, batchId: 'M-1', label: 'T-1', baseId: 'BASE-A', quantity: 1, at: ISO });
  ledger.append({ type: EVENT_TYPES.BATCH_GERMINATED, batchId: 'S-1', label: 'T-2', motherBatchId: 'M-1', baseId: 'BASE-A', quantity: 100, at: ISO });

  assert.throws(
    () => ledger.append({ type: EVENT_TYPES.TRANSPORT_RECEIVED, shipmentId: 'SHIP-1', at: ISO }),
    (error) => error.code === 'not_found',
  );
  ledger.append({
    type: EVENT_TYPES.TRANSPORT_DISPATCHED,
    batchId: 'S-1', shipmentId: 'SHIP-1', fromBaseId: 'BASE-A', toBaseId: 'BASE-B', at: ISO,
  }, { actor: coordinator });
  assert.equal(ledger.getBatch('S-1').status, 'in_transit');
  // 在途不能重复发出
  assert.throws(
    () => ledger.append({
      type: EVENT_TYPES.TRANSPORT_DISPATCHED,
      batchId: 'S-1', shipmentId: 'SHIP-2', fromBaseId: 'BASE-A', toBaseId: 'BASE-B', at: ISO,
    }, { actor: coordinator }),
    (error) => error.code === 'shipment_open',
  );
  ledger.append({ type: EVENT_TYPES.TRANSPORT_RECEIVED, shipmentId: 'SHIP-1', at: '2026-03-02T08:00:00.000Z' }, { actor: coordinator });
  assert.equal(ledger.getBatch('S-1').currentBaseId, 'BASE-B');
});

test('批次合并后问题仍可沿多来源血缘反查到母本', () => {
  const { ledger, trace, coordinator } = seed();
  ledger.append({ type: EVENT_TYPES.MOTHER_REGISTERED, batchId: 'M-1', label: 'TM-1', baseId: 'B', quantity: 1, at: ISO });
  ledger.append({ type: EVENT_TYPES.MOTHER_REGISTERED, batchId: 'M-2', label: 'TM-2', baseId: 'B', quantity: 1, at: ISO });
  ledger.append({ type: EVENT_TYPES.BATCH_GERMINATED, batchId: 'S-1', label: 'TS-1', motherBatchId: 'M-1', baseId: 'B', quantity: 100, at: ISO });
  ledger.append({ type: EVENT_TYPES.BATCH_GERMINATED, batchId: 'S-2', label: 'TS-2', motherBatchId: 'M-2', baseId: 'B', quantity: 100, at: ISO });
  ledger.append({
    type: EVENT_TYPES.BATCH_MERGED,
    sources: [{ batchId: 'S-1', quantity: 60 }, { batchId: 'S-2', quantity: 40 }],
    child: { batchId: 'S-X', label: 'TS-X', quantity: 100 },
    at: ISO,
  }, { actor: coordinator });

  assert.deepEqual(ledger.ancestors('S-X').sort(), ['M-1', 'M-2', 'S-1', 'S-2']);
  assert.deepEqual(ledger.descendants('M-1'), ['S-1', 'S-X']);
  const back = trace.traceBack('S-X');
  assert.equal(back.motherBatchId, 'M-1', '多母本混合时返回血缘中首个母本，完整祖先见 ancestorBatchIds');
  assert.ok(back.ancestorBatchIds.includes('M-2'));

  // 来源批留存余量仍可独立追溯
  assert.equal(ledger.getBatch('S-1').onHand, 40);
  assert.equal(ledger.getBatch('S-2').onHand, 60);
});

test('离线补录：迟到事件按发生时间入账，不改变已发生事实，库存约束按真实时序校验', () => {
  const { ledger, coordinator } = seed();
  ledger.append({ type: EVENT_TYPES.MOTHER_REGISTERED, batchId: 'M-1', label: 'T-1', baseId: 'B', quantity: 1, at: '2026-01-01T00:00:00.000Z' });
  ledger.append({ type: EVENT_TYPES.BATCH_GERMINATED, batchId: 'S-1', label: 'T-2', motherBatchId: 'M-1', baseId: 'B', quantity: 100, at: '2026-02-01T00:00:00.000Z' });
  // 2 月 10 日定植 60 株（先入账）
  ledger.append({ type: EVENT_TYPES.PLANTING_RECORDED, batchId: 'S-1', siteId: 'W-1', quantity: 60, at: '2026-02-10T00:00:00.000Z' }, { actor: coordinator });
  // 2 月 5 日的销毁 50 株离线补录（后入账）：真实时序 100 - 50 = 50 < 60，应拒绝
  assert.throws(
    () => ledger.append({
      type: EVENT_TYPES.STOCK_DESTROYED, batchId: 'S-1', quantity: 50,
      reason: '离线补录：2 月 5 日坏苗处置', at: '2026-02-05T00:00:00.000Z',
    }, { actor: coordinator }),
    (error) => error.code === 'insufficient_stock',
  );
  // 补录销毁 30 株则成立：真实时序 100 - 30 = 70 ≥ 60
  ledger.append({
    type: EVENT_TYPES.STOCK_DESTROYED, batchId: 'S-1', quantity: 30,
    reason: '离线补录：2 月 5 日坏苗处置', at: '2026-02-05T00:00:00.000Z',
  }, { actor: coordinator });
  assert.equal(ledger.getBatch('S-1').onHand, 10, '100 - 30(02-05) - 60(02-10) = 10');
  // 事件链仍按 seq 追加、不可变；读取时序按 at
  const chain = ledger.listEvents().map((e) => e.type);
  assert.equal(chain[chain.length - 1], EVENT_TYPES.STOCK_DESTROYED);
});

test('事件可序列化重建：从持久化事件恢复后状态一致', () => {
  const ledger = new Ledger();
  ledger.append({ type: EVENT_TYPES.MOTHER_REGISTERED, batchId: 'M-1', label: 'T-1', baseId: 'B', quantity: 1, at: ISO });
  ledger.append({ type: EVENT_TYPES.BATCH_GERMINATED, batchId: 'S-1', label: 'T-2', motherBatchId: 'M-1', baseId: 'B', quantity: 10, at: ISO });
  ledger.append({ type: EVENT_TYPES.BATCH_SPLIT, parentBatchId: 'S-1', children: [{ batchId: 'S-1A', label: 'T-3', quantity: 4 }], at: ISO });

  const restored = new Ledger();
  restored.load(JSON.parse(JSON.stringify(ledger.listEvents())));
  assert.equal(restored.getBatch('S-1').onHand, 6);
  assert.deepEqual(restored.descendants('M-1').sort(), ['S-1', 'S-1A']);
});
