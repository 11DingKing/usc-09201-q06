import { randomUUID } from 'node:crypto';
import {
  ValidationError,
  DuplicateLabelError,
  ConflictError,
  NotFoundError,
} from './errors.mjs';

// 事件类型目录：种源事件链上的全部“已发生事实”。
// 事实只可追加：更正通过新事件（INSPECTION_CORRECTED）表达，不覆盖旧事件。
export const EVENT_TYPES = Object.freeze({
  MOTHER_REGISTERED: 'mother_registered',         // 母本登记
  BATCH_GERMINATED: 'batch_germinated',           // 育苗批播种/出苗
  BATCH_SPLIT: 'batch_split',                     // 批次拆分
  BATCH_MERGED: 'batch_merged',                   // 批次合并
  INSPECTION_RECORDED: 'inspection_recorded',     // 检验结果登记
  INSPECTION_CORRECTED: 'inspection_corrected',   // 检验结果更正（不删除原结果）
  TRANSPORT_DISPATCHED: 'transport_dispatched',   // 跨基地调拨：发出
  TRANSPORT_RECEIVED: 'transport_received',       // 跨基地调拨：接收
  PLANTING_RECORDED: 'planting_recorded',         // 林下定植
  QUARANTINE_ORDERED: 'quarantine_ordered',       // 隔离/暂扣（召回处置）
  STOCK_DESTROYED: 'stock_destroyed',             // 无害化处置
  RECALL_ISSUED: 'recall_issued',                 // 定向召回发布
  RECALL_NOTIFIED: 'recall_notified',             // 召回通知送达（去重单位）
  RECALL_ACKNOWLEDGED: 'recall_acknowledged',     // 召回执行确认
});

const REQUIRED = Object.freeze({
  [EVENT_TYPES.MOTHER_REGISTERED]: ['batchId', 'label', 'baseId'],
  [EVENT_TYPES.BATCH_GERMINATED]: ['batchId', 'label', 'motherBatchId', 'baseId'],
  [EVENT_TYPES.BATCH_SPLIT]: ['parentBatchId', 'children'],
  [EVENT_TYPES.BATCH_MERGED]: ['sources', 'child'],
  [EVENT_TYPES.INSPECTION_RECORDED]: ['batchId', 'verdict'],
  [EVENT_TYPES.INSPECTION_CORRECTED]: ['supersedes', 'batchId', 'verdict', 'reason'],
  [EVENT_TYPES.TRANSPORT_DISPATCHED]: ['batchId', 'shipmentId', 'fromBaseId', 'toBaseId'],
  [EVENT_TYPES.TRANSPORT_RECEIVED]: ['shipmentId'],
  [EVENT_TYPES.PLANTING_RECORDED]: ['batchId', 'siteId', 'quantity'],
  [EVENT_TYPES.QUARANTINE_ORDERED]: ['batchId', 'reason'],
  [EVENT_TYPES.STOCK_DESTROYED]: ['batchId', 'quantity', 'reason'],
  [EVENT_TYPES.RECALL_ISSUED]: ['recallId', 'triggerBatchId', 'reason'],
  [EVENT_TYPES.RECALL_NOTIFIED]: ['recallId', 'recipientType', 'recipientId', 'scopeKey'],
  [EVENT_TYPES.RECALL_ACKNOWLEDGED]: ['recallId', 'targetType', 'targetId'],
});

export const VERDICTS = Object.freeze({
  QUALIFIED: 'qualified',
  CONDITIONAL: 'conditional',
  UNQUALIFIED: 'unqualified',
});

function parseAt(event) {
  if (event.at === undefined || event.at === null) return null;
  const time = Date.parse(event.at);
  if (Number.isNaN(time)) {
    throw new ValidationError(`事件 ${event.type} 的时间字段 at 非法：${event.at}`);
  }
  return time;
}

function qty(value, field, eventType) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`事件 ${eventType} 的 ${field} 必须为正数`);
  }
  return value;
}

// 投影重建：按“发生时间 (at, seq)”归约，而非入账顺序。
// 因此离线采集的迟到事件按其真实发生时刻参与库存校验，补录不会改写既有事实。
function buildState(events) {
  const state = {
    batches: new Map(),
    labels: new Map(),
    shipments: new Map(),
    inspections: new Map(),
    batchInspectionIds: new Map(),
    plants: [],
    recalls: new Map(),
    notifications: new Set(),
    acks: new Set(),
    edges: { parents: new Map(), children: new Map() }, // 拆/合批血缘
  };

  const link = (childId, parentIds) => {
    state.edges.parents.set(childId, parentIds);
    for (const pid of parentIds) {
      const list = state.edges.children.get(pid) ?? [];
      list.push(childId);
      state.edges.children.set(pid, list);
    }
  };

  const addBatch = (event, batch) => {
    if (state.batches.has(batch.batchId)) {
      throw new ConflictError(`批次编号已存在：${batch.batchId}`, 'batch_duplicate');
    }
    if (state.labels.has(batch.label)) {
      throw new DuplicateLabelError(`标签重复：${batch.label}（已绑定批次 ${state.labels.get(batch.label)}）`);
    }
    state.batches.set(batch.batchId, batch);
    state.labels.set(batch.label, batch.batchId);
    if (!state.edges.parents.has(batch.batchId)) state.edges.parents.set(batch.batchId, []);
    if (!state.edges.children.has(batch.batchId)) state.edges.children.set(batch.batchId, []);
    void event;
  };

  for (const event of events) {
    switch (event.type) {
      case EVENT_TYPES.MOTHER_REGISTERED: {
        addBatch(event, {
          batchId: event.batchId,
          kind: 'mother',
          label: event.label,
          unit: event.unit ?? '株',
          baseId: event.baseId,
          currentBaseId: event.baseId,
          motherBatchId: event.batchId,
          producedFrom: [],
          onHand: qty(event.quantity ?? 1, 'quantity', event.type),
          plantedQty: 0,
          destroyedQty: 0,
          quarantinedQty: 0,
          status: 'active',
          firstEventAt: event.at,
        });
        break;
      }
      case EVENT_TYPES.BATCH_GERMINATED: {
        const mother = state.batches.get(event.motherBatchId);
        if (!mother) throw new NotFoundError(`母本不存在：${event.motherBatchId}`);
        if (mother.kind !== 'mother') {
          throw new ValidationError(`批次 ${event.motherBatchId} 不是母本，不能用于育苗`);
        }
        addBatch(event, {
          batchId: event.batchId,
          kind: 'seedling',
          label: event.label,
          unit: event.unit ?? mother.unit,
          baseId: event.baseId,
          currentBaseId: event.baseId,
          motherBatchId: mother.batchId,
          producedFrom: [mother.batchId],
          medium: event.medium ?? null,
          onHand: qty(event.quantity, 'quantity', event.type),
          plantedQty: 0,
          destroyedQty: 0,
          quarantinedQty: 0,
          status: 'nursing',
          firstEventAt: event.at,
        });
        link(event.batchId, [event.motherBatchId]);
        break;
      }
      case EVENT_TYPES.BATCH_SPLIT: {
        const parent = state.batches.get(event.parentBatchId);
        if (!parent) throw new NotFoundError(`拆分父批次不存在：${event.parentBatchId}`);
        if (!Array.isArray(event.children) || event.children.length === 0) {
          throw new ValidationError('拆分事件必须给出至少一个子批次');
        }
        let total = 0;
        for (const child of event.children) {
          total += qty(child.quantity, 'children[].quantity', event.type);
          if (!child.batchId || !child.label) {
            throw new ValidationError('拆分子批次必须包含 batchId 与 label');
          }
        }
        if (total > parent.onHand) {
          throw new ConflictError(
            `拆分量 ${total} 超过批次 ${parent.batchId} 现存量 ${parent.onHand}`,
            'insufficient_stock',
          );
        }
        const childIds = [];
        for (const child of event.children) {
          addBatch(event, {
            batchId: child.batchId,
            label: child.label,
            kind: 'seedling',
            unit: parent.unit,
            baseId: parent.currentBaseId,
            currentBaseId: parent.currentBaseId,
            motherBatchId: parent.motherBatchId,
            producedFrom: [parent.batchId],
            onHand: child.quantity,
            plantedQty: 0,
            destroyedQty: 0,
            quarantinedQty: 0,
            status: 'nursing',
            firstEventAt: event.at,
          });
          childIds.push(child.batchId);
          link(child.batchId, [parent.batchId]);
        }
        parent.onHand -= total;
        parent.status = parent.onHand === 0 ? 'split_out' : parent.status;
        break;
      }
      case EVENT_TYPES.BATCH_MERGED: {
        if (!Array.isArray(event.sources) || event.sources.length < 2) {
          throw new ValidationError('合并事件至少需要两个来源批次');
        }
        let mergedQty = 0;
        const sourceIds = [];
        for (const source of event.sources) {
          const batch = state.batches.get(source.batchId);
          if (!batch) throw new NotFoundError(`合并来源批次不存在：${source.batchId}`);
          const take = source.quantity ?? batch.onHand;
          qty(take, 'sources[].quantity', event.type);
          if (take > batch.onHand) {
            throw new ConflictError(
              `合并取用量 ${take} 超过批次 ${batch.batchId} 现存量 ${batch.onHand}`,
              'insufficient_stock',
            );
          }
          batch.onHand -= take;
          mergedQty += take;
          sourceIds.push(source.batchId);
        }
        const childQty = event.child.quantity ?? mergedQty;
        if (childQty > mergedQty) {
          throw new ValidationError(`合并后数量 ${childQty} 不能大于来源总量 ${mergedQty}`);
        }
        addBatch(event, {
          batchId: event.child.batchId,
          label: event.child.label,
          kind: 'blend',
          unit: state.batches.get(sourceIds[0]).unit,
          baseId: state.batches.get(sourceIds[0]).currentBaseId,
          currentBaseId: state.batches.get(sourceIds[0]).currentBaseId,
          motherBatchId: null, // 混合批的母本血缘通过 edges 向上追溯
          producedFrom: sourceIds,
          onHand: childQty,
          plantedQty: 0,
          destroyedQty: 0,
          quarantinedQty: 0,
          status: 'nursing',
          firstEventAt: event.at,
        });
        // 合并不足总量时的余量在来源批次留存（onHand 已扣除取用量）。
        link(event.child.batchId, sourceIds);
        break;
      }
      case EVENT_TYPES.INSPECTION_RECORDED: {
        if (!state.batches.has(event.batchId)) throw new NotFoundError(`检验批次不存在：${event.batchId}`);
        if (!Object.values(VERDICTS).includes(event.verdict)) {
          throw new ValidationError(`未知检验结论：${event.verdict}`);
        }
        state.inspections.set(event.eventId, {
          eventId: event.eventId,
          batchId: event.batchId,
          verdict: event.verdict,
          items: Array.isArray(event.items) ? event.items : [],
          lab: event.lab ?? null,
          at: event.at,
          recordedAt: event.recordedAt,
          active: true,
          supersededBy: null,
        });
        const list = state.batchInspectionIds.get(event.batchId) ?? [];
        list.push(event.eventId);
        state.batchInspectionIds.set(event.batchId, list);
        break;
      }
      case EVENT_TYPES.INSPECTION_CORRECTED: {
        const original = state.inspections.get(event.supersedes);
        if (!original) throw new NotFoundError(`待更正检验事件不存在：${event.supersedes}`);
        if (!original.active) {
          throw new ConflictError(`检验事件 ${event.supersedes} 已被更正，不能重复更正`, 'result_already_corrected');
        }
        if (original.batchId !== event.batchId) {
          throw new ValidationError('更正事件与原检验事件的批次不一致');
        }
        if (Date.parse(event.at) < Date.parse(original.at)) {
          throw new ValidationError('更正发生时间不能早于原检验时间');
        }
        original.active = false;
        original.supersededBy = event.eventId;
        state.inspections.set(event.eventId, {
          eventId: event.eventId,
          batchId: event.batchId,
          verdict: event.verdict,
          items: Array.isArray(event.items) ? event.items : [],
          lab: event.lab ?? original.lab,
          at: event.at,
          recordedAt: event.recordedAt,
          reason: event.reason,
          correctionOf: event.supersedes,
          active: true,
          supersededBy: null,
        });
        const list = state.batchInspectionIds.get(event.batchId) ?? [];
        list.push(event.eventId);
        state.batchInspectionIds.set(event.batchId, list);
        break;
      }
      case EVENT_TYPES.TRANSPORT_DISPATCHED: {
        const batch = state.batches.get(event.batchId);
        if (!batch) throw new NotFoundError(`调拨批次不存在：${event.batchId}`);
        if (state.shipments.has(event.shipmentId)) {
          throw new ConflictError(`调拨单号重复：${event.shipmentId}`, 'shipment_duplicate');
        }
        if (batch.openShipmentId) {
          throw new ConflictError(`批次 ${batch.batchId} 已有在途调拨 ${batch.openShipmentId}`, 'shipment_open');
        }
        if (event.fromBaseId !== batch.currentBaseId) {
          throw new ConflictError(
            `调出基地 ${event.fromBaseId} 与批次当前所在 ${batch.currentBaseId} 不一致`,
            'base_mismatch',
          );
        }
        if (event.quantity !== undefined && event.quantity !== batch.onHand) {
          throw new ValidationError('仅支持整批调拨；部分转运请先执行批次拆分');
        }
        if (batch.quarantinedQty > 0) {
          throw new ConflictError(`批次 ${batch.batchId} 存在隔离库存，禁止调出`, 'quarantined_stock');
        }
        state.shipments.set(event.shipmentId, {
          shipmentId: event.shipmentId,
          batchId: event.batchId,
          fromBaseId: event.fromBaseId,
          toBaseId: event.toBaseId,
          dispatchedAt: event.at,
          dispatchedBy: event.actor?.id ?? null,
          receivedAt: null,
          status: 'in_transit',
        });
        batch.openShipmentId = event.shipmentId;
        batch.status = 'in_transit';
        break;
      }
      case EVENT_TYPES.TRANSPORT_RECEIVED: {
        const shipment = state.shipments.get(event.shipmentId);
        if (!shipment) throw new NotFoundError(`调拨单不存在：${event.shipmentId}`);
        if (shipment.status !== 'in_transit') {
          throw new ConflictError(`调拨单 ${event.shipmentId} 已接收`, 'shipment_closed');
        }
        if (Date.parse(event.at) < Date.parse(shipment.dispatchedAt)) {
          throw new ValidationError('接收时间不能早于发出时间');
        }
        shipment.receivedAt = event.at;
        shipment.receivedBy = event.actor?.id ?? null;
        shipment.status = 'received';
        const batch = state.batches.get(shipment.batchId);
        batch.currentBaseId = shipment.toBaseId;
        batch.openShipmentId = null;
        batch.status = 'received';
        break;
      }
      case EVENT_TYPES.PLANTING_RECORDED: {
        const batch = state.batches.get(event.batchId);
        if (!batch) throw new NotFoundError(`定植批次不存在：${event.batchId}`);
        const quantity = qty(event.quantity, 'quantity', event.type);
        const plantable = batch.onHand - batch.quarantinedQty;
        if (quantity > plantable) {
          throw new ConflictError(
            `定植量 ${quantity} 超过批次 ${batch.batchId} 可种存量 ${plantable}（隔离库存不可定植）`,
            'insufficient_stock',
          );
        }
        batch.onHand -= quantity;
        batch.plantedQty += quantity;
        state.plants.push({
          plantEventId: event.eventId,
          batchId: event.batchId,
          siteId: event.siteId,
          parcelId: event.parcelId ?? null,
          farmerId: event.farmerId ?? null,
          baseId: batch.currentBaseId,
          quantity,
          at: event.at,
        });
        if (batch.onHand === 0) batch.status = 'planted';
        break;
      }
      case EVENT_TYPES.QUARANTINE_ORDERED: {
        const batch = state.batches.get(event.batchId);
        if (!batch) throw new NotFoundError(`隔离批次不存在：${event.batchId}`);
        const quantity = Math.min(event.quantity ?? batch.onHand, batch.onHand);
        qty(quantity, 'quantity', event.type);
        batch.quarantinedQty += quantity;
        if (batch.status !== 'in_transit') batch.status = 'quarantined';
        break;
      }
      case EVENT_TYPES.STOCK_DESTROYED: {
        const batch = state.batches.get(event.batchId);
        if (!batch) throw new NotFoundError(`处置批次不存在：${event.batchId}`);
        const quantity = qty(event.quantity, 'quantity', event.type);
        if (quantity > batch.onHand) {
          throw new ConflictError(`处置量 ${quantity} 超过批次 ${batch.batchId} 现存量 ${batch.onHand}`, 'insufficient_stock');
        }
        const fromQuarantine = Math.min(batch.quarantinedQty, quantity);
        batch.quarantinedQty -= fromQuarantine;
        batch.onHand -= quantity;
        batch.destroyedQty += quantity;
        if (batch.onHand === 0 && batch.plantedQty === 0) batch.status = 'destroyed';
        break;
      }
      case EVENT_TYPES.RECALL_ISSUED: {
        if (state.recalls.has(event.recallId)) {
          throw new ConflictError(`召回单号重复：${event.recallId}`, 'recall_duplicate');
        }
        if (!state.batches.has(event.triggerBatchId)) {
          throw new NotFoundError(`召回触发批次不存在：${event.triggerBatchId}`);
        }
        state.recalls.set(event.recallId, {
          recallId: event.recallId,
          triggerBatchId: event.triggerBatchId,
          reason: event.reason,
          severity: event.severity ?? 'standard',
          at: event.at,
          issuedBy: event.actor?.id ?? null,
        });
        break;
      }
      case EVENT_TYPES.RECALL_NOTIFIED: {
        const key = `${event.recallId}|${event.scopeKey}`;
        if (!state.recalls.has(event.recallId)) throw new NotFoundError(`召回单不存在：${event.recallId}`);
        if (state.notifications.has(key)) {
          throw new ConflictError(`召回 ${event.recallId} 对 ${event.scopeKey} 的通知已存在`, 'notification_duplicate');
        }
        state.notifications.add(key);
        break;
      }
      case EVENT_TYPES.RECALL_ACKNOWLEDGED: {
        if (!state.recalls.has(event.recallId)) throw new NotFoundError(`召回单不存在：${event.recallId}`);
        if (event.targetType === 'site') {
          const ok = state.plants.some((plant) => plant.siteId === event.targetId);
          if (!ok) throw new NotFoundError(`定植点不存在：${event.targetId}`);
        } else if (event.targetType === 'batch') {
          if (!state.batches.has(event.targetId)) throw new NotFoundError(`批次不存在：${event.targetId}`);
        } else {
          throw new ValidationError("确认目标类型必须是 site 或 batch");
        }
        state.acks.add(`${event.recallId}|${event.targetType}|${event.targetId}`);
        break;
      }
      default:
        throw new ValidationError(`未知事件类型：${event.type}`);
    }
  }

  return state;
}

export class Ledger {
  constructor({ now = () => new Date() } = {}) {
    this.events = [];
    this._seq = 0;
    this._now = now;
    this.state = buildState([]);
  }

  // 从持久化事件数组恢复（联系人、研究数据等分区在账本之外另行加载）。
  load(events) {
    for (const event of events) this._assertEnvelope(event);
    this.events = [...events].sort((a, b) => a.seq - b.seq);
    this._seq = this.events.reduce((max, event) => Math.max(max, event.seq), 0);
    this._rebuild();
  }

  _rebuild() {
    const ordered = [...this.events].sort((a, b) => {
      const ta = Date.parse(a.at);
      const tb = Date.parse(b.at);
      return ta - tb || a.seq - b.seq;
    });
    this.state = buildState(ordered);
  }

  _assertEnvelope(event) {
    if (!event || typeof event !== 'object') throw new ValidationError('事件必须为对象');
    if (!new Set(Object.values(EVENT_TYPES)).has(event.type)) {
      throw new ValidationError(`未知事件类型：${event.type}`);
    }
    for (const field of REQUIRED[event.type] ?? []) {
      const value = event[field];
      if (value === undefined || value === null || value === '') {
        throw new ValidationError(`事件 ${event.type} 缺少必填字段 ${field}`);
      }
    }
    parseAt(event);
  }

  // 追加事件。clientEventId 用于离线端幂等；重复提交返回已存在事件且 deduplicated=true。
  append(input, { actor = null } = {}) {
    if (!input || typeof input !== 'object') throw new ValidationError('事件必须为对象');
    if (input.eventId) {
      const existing = this.events.find((event) => event.eventId === input.eventId);
      if (existing) return { event: existing, deduplicated: true };
    }
    const event = { ...input };
    event.eventId = event.eventId ?? randomUUID();
    event.at = event.at ?? this._now().toISOString();
    event.recordedAt = this._now().toISOString();
    event.seq = ++this._seq;
    if (actor) event.actor = { id: actor.id, role: actor.role, baseId: actor.baseId ?? null };

    this._assertEnvelope(event);
    // 标签编号冲突在追加前给出明确错误（与事件时间无关：物理标签全局唯一）。
    if (event.label && this.state.labels.has(event.label)) {
      throw new DuplicateLabelError(`标签重复：${event.label}（已绑定批次 ${this.state.labels.get(event.label)}）`);
    }
    if (event.child?.label && this.state.labels.has(event.child.label)) {
      throw new DuplicateLabelError(`标签重复：${event.child.label}`);
    }
    for (const child of event.children ?? []) {
      if (child.label && this.state.labels.has(child.label)) {
        throw new DuplicateLabelError(`标签重复：${child.label}`);
      }
    }

    this.events.push(event);
    try {
      this._rebuild();
    } catch (error) {
      this.events.pop();
      this._seq -= 1;
      this._rebuild();
      throw error;
    }
    return { event, deduplicated: false };
  }

  listEvents({ fromSeq = 0, limit = 200 } = {}) {
    return this.events
      .filter((event) => event.seq > fromSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  // 整组追加：一批离线事件可能乱序到达（母本/育苗事件传输错位），
  // 先全部暂存、统一编号，再按 (at, seq) 一次重建校验；任一事件不合法则整组回滚。
  appendMany(items, { actor = null } = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new ValidationError('批量事件必须为非空数组');
    }
    const snapshotEvents = [...this.events];
    const snapshotSeq = this._seq;
    const results = [];
    const claimedLabels = new Set();
    try {
      for (const input of items) {
        if (input?.eventId) {
          const existing = this.events.find((event) => event.eventId === input.eventId);
          if (existing) {
            results.push({ event: existing, deduplicated: true });
            continue;
          }
        }
        const event = { ...input };
        event.eventId = event.eventId ?? randomUUID();
        event.at = event.at ?? this._now().toISOString();
        event.recordedAt = this._now().toISOString();
        event.seq = ++this._seq;
        if (actor) event.actor = { id: actor.id, role: actor.role, baseId: actor.baseId ?? null };
        this._assertEnvelope(event);
        for (const label of [
          event.label,
          event.child?.label,
          ...(event.children ?? []).map((child) => child.label),
        ].filter(Boolean)) {
          if (this.state.labels.has(label) || claimedLabels.has(label)) {
            throw new DuplicateLabelError(`标签重复：${label}`);
          }
          claimedLabels.add(label);
        }
        this.events.push(event);
        results.push({ event, deduplicated: false });
      }
      this._rebuild();
      return results;
    } catch (error) {
      this.events = snapshotEvents;
      this._seq = snapshotSeq;
      this._rebuild();
      throw error;
    }
  }

  getEvent(eventId) {
    return this.events.find((event) => event.eventId === eventId) ?? null;
  }

  getBatch(batchId) {
    return this.state.batches.get(batchId) ?? null;
  }

  listBatches() {
    return [...this.state.batches.values()];
  }

  // 某批次当前有效检验结论（被更正的旧结果不参与）。
  effectiveInspection(batchId) {
    const ids = this.state.batchInspectionIds.get(batchId) ?? [];
    const active = ids
      .map((id) => this.state.inspections.get(id))
      .filter((inspection) => inspection.active)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.recordedAt.localeCompare(a.recordedAt));
    return active[0] ?? null;
  }

  inspectionHistory(batchId) {
    const ids = this.state.batchInspectionIds.get(batchId) ?? [];
    return ids.map((id) => this.state.inspections.get(id));
  }

  plantsOfBatch(batchId) {
    return this.state.plants.filter((plant) => plant.batchId === batchId);
  }

  ancestors(batchId) {
    const result = [];
    const queue = [...(this.state.edges.parents.get(batchId) ?? [])];
    const seen = new Set();
    while (queue.length > 0) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(id);
      queue.push(...(this.state.edges.parents.get(id) ?? []));
    }
    return result;
  }

  descendants(batchId) {
    const result = [];
    const queue = [...(this.state.edges.children.get(batchId) ?? [])];
    const seen = new Set();
    while (queue.length > 0) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(id);
      queue.push(...(this.state.edges.children.get(id) ?? []));
    }
    return result;
  }
}
