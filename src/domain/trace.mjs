import { EVENT_TYPES } from './ledger.mjs';
import { NotFoundError, ConflictError } from './errors.mjs';

// 影响分析与定向召回：
// 从触发批次（如补录了不合格检验的育苗批）沿拆/合批血缘向下闭包，
// 汇总受影响在库批次、在途调拨、定植点，并对通知对象去重。

const BATCH_EVENT_TYPES = new Set([
  EVENT_TYPES.BATCH_GERMINATED,
  EVENT_TYPES.BATCH_SPLIT,
  EVENT_TYPES.BATCH_MERGED,
  EVENT_TYPES.INSPECTION_RECORDED,
  EVENT_TYPES.INSPECTION_CORRECTED,
  EVENT_TYPES.TRANSPORT_DISPATCHED,
  EVENT_TYPES.TRANSPORT_RECEIVED,
  EVENT_TYPES.PLANTING_RECORDED,
  EVENT_TYPES.QUARANTINE_ORDERED,
  EVENT_TYPES.STOCK_DESTROYED,
]);

export class TraceService {
  constructor(ledger, directory) {
    this.ledger = ledger;
    this.directory = directory;
  }

  // 成活率异常反查：沿血缘向上找到母本与育苗条件，并按时序给出该批次经历的事件链。
  traceBack(batchId) {
    if (!this.ledger.getBatch(batchId)) throw new NotFoundError(`批次不存在：${batchId}`);
    const ancestorIds = this.ledger.ancestors(batchId);
    const mother = [batchId, ...ancestorIds]
      .map((id) => this.ledger.getBatch(id))
      .find((batch) => batch.kind === 'mother') ?? null;

    const nursing = this.ledger.events
      .filter((event) => event.type === EVENT_TYPES.BATCH_GERMINATED && event.batchId === batchId)
      .map((event) => ({
        batchId: event.batchId,
        baseId: event.baseId,
        medium: event.medium ?? null,
        quantity: event.quantity,
        germinatedAt: event.at,
      }))[0] ?? null;

    const chain = this.ledger.events
      .filter((event) => BATCH_EVENT_TYPES.has(event.type) && this._touchesBatch(event, batchId))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq);

    const distributions = this.ledger.events
      .filter((event) => event.type === EVENT_TYPES.PLANTING_RECORDED && this._inClosure(event.batchId, batchId))
      .map((event) => ({
        batchId: event.batchId,
        siteId: event.siteId,
        parcelId: event.parcelId ?? null,
        farmerId: event.farmerId ?? null,
        baseId: this.ledger.getBatch(event.batchId)?.currentBaseId ?? null,
        quantity: event.quantity,
        at: event.at,
      }));

    return {
      batchId,
      motherBatchId: mother?.batchId ?? null,
      motherLabel: mother?.label ?? null,
      ancestorBatchIds: ancestorIds,
      nursing,
      inspectionHistory: this.ledger.inspectionHistory(batchId),
      chain,
      distributions,
    };
  }

  _touchesBatch(event, batchId) {
    if (event.batchId === batchId) return true;
    if (event.parentBatchId === batchId) return true;
    if (event.sources?.some((source) => source.batchId === batchId)) return true;
    if (event.children?.some((child) => child.batchId === batchId)) return true;
    // 拆分/合并产生的后代批次事件：通过血缘闭包判断
    if (event.batchId && this._inClosure(event.batchId, batchId)) return true;
    return false;
  }

  _inClosure(candidateId, rootId) {
    if (candidateId === rootId) return true;
    return this.ledger.ancestors(candidateId).includes(rootId);
  }

  // 影响范围：触发批次 + 全部下游批次的库存与定植去向。
  impactPlan(triggerBatchId) {
    if (!this.ledger.getBatch(triggerBatchId)) {
      throw new NotFoundError(`触发批次不存在：${triggerBatchId}`);
    }
    const closureIds = [triggerBatchId, ...this.ledger.descendants(triggerBatchId)];

    const batches = closureIds.map((id) => {
      const batch = this.ledger.getBatch(id);
      const inspection = this.ledger.effectiveInspection(id);
      return {
        batchId: id,
        label: batch.label,
        kind: batch.kind,
        currentBaseId: batch.currentBaseId,
        status: batch.status,
        onHand: batch.onHand,
        plantedQty: batch.plantedQty,
        quarantinedQty: batch.quarantinedQty,
        destroyedQty: batch.destroyedQty,
        usableQty: Math.max(batch.onHand - batch.quarantinedQty, 0),
        motherBatchId: batch.motherBatchId,
        effectiveVerdict: inspection?.verdict ?? null,
        effectiveInspectionId: inspection?.eventId ?? null,
        shipmentId: batch.openShipmentId,
      };
    });

    // 定植点汇总（同一林地的多个定植事件合并）。
    const siteMap = new Map();
    for (const id of closureIds) {
      for (const plant of this.ledger.plantsOfBatch(id)) {
        const entry = siteMap.get(plant.siteId) ?? {
          siteId: plant.siteId,
          baseId: plant.baseId,
          parcelIds: new Set(),
          farmerIds: new Set(),
          batchIds: new Set(),
          quantity: 0,
          plantedEvents: [],
        };
        entry.quantity += plant.quantity;
        if (plant.parcelId) entry.parcelIds.add(plant.parcelId);
        if (plant.farmerId) entry.farmerIds.add(plant.farmerId);
        entry.batchIds.add(plant.batchId);
        entry.plantedEvents.push({
          batchId: plant.batchId,
          quantity: plant.quantity,
          at: plant.at,
          plantEventId: plant.plantEventId,
        });
        siteMap.set(plant.siteId, entry);
      }
    }
    const sites = [...siteMap.values()].map((entry) => ({
      siteId: entry.siteId,
      baseId: entry.baseId,
      parcelIds: [...entry.parcelIds],
      farmerIds: [...entry.farmerIds],
      batchIds: [...entry.batchIds],
      quantity: entry.quantity,
      plantedEvents: entry.plantedEvents,
    }));

    // 通知对象去重：一个农户承包多处林地只通知一次；一个基地只通知一次。
    const farmerIds = new Set();
    const baseIds = new Set();
    for (const site of sites) {
      site.farmerIds.forEach((farmerId) => farmerIds.add(farmerId));
      if (site.baseId) baseIds.add(site.baseId);
    }
    const heldBatches = batches.filter((batch) => batch.onHand > 0);
    for (const batch of heldBatches) {
      if (batch.currentBaseId) baseIds.add(batch.currentBaseId);
    }

    const totals = batches.reduce(
      (sum, batch) => ({
        onHand: sum.onHand + batch.onHand,
        usableQty: sum.usableQty + batch.usableQty,
        plantedQty: sum.plantedQty + batch.plantedQty,
        quarantinedQty: sum.quarantinedQty + batch.quarantinedQty,
        destroyedQty: sum.destroyedQty + batch.destroyedQty,
      }),
      { onHand: 0, usableQty: 0, plantedQty: 0, quarantinedQty: 0, destroyedQty: 0 },
    );

    const inTransit = batches
      .filter((batch) => batch.shipmentId)
      .map((batch) => ({ batchId: batch.batchId, shipmentId: batch.shipmentId, baseId: batch.currentBaseId }));

    return {
      triggerBatchId,
      batchIds: closureIds,
      batches,
      sites,
      recipients: {
        farmers: [...farmerIds],
        bases: [...baseIds],
      },
      heldBatches: heldBatches.map((batch) => batch.batchId),
      inTransit,
      totals,
      // 剩余可用数量：仍在库、未被隔离、尚可继续种植/调配的数量（召回执行时应清零）。
      remainingUsableQuantity: totals.usableQty,
      affectedPlantedQuantity: totals.plantedQty,
    };
  }

  // 已通知对象（按 scopeKey 去重，scopeKey 即通知定向键）。
  notifiedScopes(recallId) {
    return this.ledger.events
      .filter((event) => event.type === EVENT_TYPES.RECALL_NOTIFIED && event.recallId === recallId)
      .map((event) => event.scopeKey);
  }

  // 生成召回单并向计划中的全部对象发通知；对同一召回单重复执行是幂等的。
  issueRecall(triggerBatchId, { recallId, reason, severity = 'standard', actor = null, at } = {}) {
    const plan = this.impactPlan(triggerBatchId);
    let issued;
    const alreadyIssued = this.ledger.events.find((event) =>
      event.type === EVENT_TYPES.RECALL_ISSUED && event.recallId === recallId);
    if (alreadyIssued) {
      if (alreadyIssued.triggerBatchId !== triggerBatchId) {
        throw new ConflictError(
          `召回单 ${recallId} 的触发批次为 ${alreadyIssued.triggerBatchId}，不能改用 ${triggerBatchId}`,
          'recall_trigger_mismatch',
        );
      }
      issued = alreadyIssued; // 召回单已发布：事实不变，只可能补发缺失通知
    } else {
      issued = this.ledger.append(
        {
          type: EVENT_TYPES.RECALL_ISSUED,
          recallId,
          triggerBatchId,
          reason,
          severity,
          at,
        },
        { actor },
      ).event;
    }

    const notifications = [];
    const skipped = [];
    const existing = new Set(this.notifiedScopes(recallId));
    const notify = (recipientType, recipientId, scopeKey) => {
      if (existing.has(scopeKey)) {
        skipped.push(scopeKey);
        return;
      }
      const { event } = this.ledger.append(
        {
          type: EVENT_TYPES.RECALL_NOTIFIED,
          recallId,
          recipientType,
          recipientId,
          scopeKey,
          at,
        },
        { actor },
      );
      existing.add(scopeKey);
      notifications.push(event);
    };

    for (const farmerId of plan.recipients.farmers) {
      notify('farmer', farmerId, `farmer:${farmerId}`);
    }
    for (const baseId of plan.recipients.bases) {
      notify('base', baseId, `base:${baseId}`);
    }
    // 在途批次额外通知承运方向（记录在调拨单上的调度基地已包含在 bases 中）。
    for (const transit of plan.inTransit) {
      notify('shipment', transit.shipmentId, `shipment:${transit.shipmentId}`);
    }

    return { recall: issued, plan, notifications, skippedDuplicates: skipped };
  }

  // 召回扩容：血缘后续又出现新的定植点/在库批次时，补发缺失通知（仍去重）。
  expandRecall(recallId, { actor = null, at } = {}) {
    const issued = this.ledger.events.find((event) =>
      event.type === EVENT_TYPES.RECALL_ISSUED && event.recallId === recallId);
    if (!issued) throw new NotFoundError(`召回单不存在：${recallId}`);
    const plan = this.impactPlan(issued.triggerBatchId);
    const existing = new Set(this.notifiedScopes(recallId));
    const added = [];
    const notify = (recipientType, recipientId, scopeKey) => {
      if (existing.has(scopeKey)) return;
      const { event } = this.ledger.append(
        { type: EVENT_TYPES.RECALL_NOTIFIED, recallId, recipientType, recipientId, scopeKey, at },
        { actor },
      );
      existing.add(scopeKey);
      added.push(event);
    };
    for (const farmerId of plan.recipients.farmers) notify('farmer', farmerId, `farmer:${farmerId}`);
    for (const baseId of plan.recipients.bases) notify('base', baseId, `base:${baseId}`);
    for (const transit of plan.inTransit) notify('shipment', transit.shipmentId, `shipment:${transit.shipmentId}`);
    return { plan, added, alreadyNotified: [...existing] };
  }

  // 对影响范围内的全部在库库存下达隔离，返回生成的事件。
  quarantineImpact(triggerBatchId, { reason, actor = null, at } = {}) {
    const plan = this.impactPlan(triggerBatchId);
    const events = [];
    for (const batch of plan.batches) {
      const qtyToHold = Math.max(batch.onHand - batch.quarantinedQty, 0);
      if (qtyToHold <= 0) continue;
      const { event } = this.ledger.append(
        {
          type: EVENT_TYPES.QUARANTINE_ORDERED,
          batchId: batch.batchId,
          quantity: qtyToHold,
          reason,
          at,
        },
        { actor },
      );
      events.push(event);
    }
    return events;
  }

  acknowledge(recallId, targetType, targetId, { actor = null, at } = {}) {
    const key = `${recallId}|${targetType}|${targetId}`;
    const existing = this.ledger.events.find((event) =>
      event.type === EVENT_TYPES.RECALL_ACKNOWLEDGED
      && `${event.recallId}|${event.targetType}|${event.targetId}` === key);
    if (existing) return { event: existing, deduplicated: true };
    const { event } = this.ledger.append(
      { type: EVENT_TYPES.RECALL_ACKNOWLEDGED, recallId, targetType, targetId, at },
      { actor },
    );
    return { event, deduplicated: false };
  }

  recallStatus(recallId) {
    const issued = this.ledger.events.find((event) =>
      event.type === EVENT_TYPES.RECALL_ISSUED && event.recallId === recallId);
    if (!issued) throw new NotFoundError(`召回单不存在：${recallId}`);
    const plan = this.impactPlan(issued.triggerBatchId);
    const notified = this.notifiedScopes(recallId);
    const ackEvents = this.ledger.events.filter(
      (event) => event.type === EVENT_TYPES.RECALL_ACKNOWLEDGED && event.recallId === recallId,
    );
    const ackKeys = new Set(ackEvents.map((event) => `${event.targetType}:${event.targetId}`));

    // 执行确认以受影响站点（定植去向）和仍在库批次（处置去向）为口径。
    const expectedSites = plan.sites.map((site) => `site:${site.siteId}`);
    const expectedBatches = plan.heldBatches.map((batchId) => `batch:${batchId}`);
    const expectedExecutions = [...expectedSites, ...expectedBatches];
    const pendingExecutions = expectedExecutions.filter((key) => !ackKeys.has(key));

    return {
      recallId,
      triggerBatchId: issued.triggerBatchId,
      reason: issued.reason,
      issuedAt: issued.at,
      planSummary: {
        affectedBatchIds: plan.batchIds,
        affectedSiteIds: plan.sites.map((site) => site.siteId),
        remainingUsableQuantity: plan.remainingUsableQuantity,
        affectedPlantedQuantity: plan.affectedPlantedQuantity,
      },
      notifiedScopes: notified,
      acknowledgedScopes: [...ackKeys],
      pendingExecutions,
    };
  }
}
