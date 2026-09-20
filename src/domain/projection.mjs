// 纯函数投影：把全部事件回放为当前状态。
// 事件不可变，任何“更正”都体现为追加的新事件，这里折叠出当前有效结论。

export function foldEvents(events) {
  const mothers = new Map();
  const batches = new Map();
  const recalls = new Map();
  // 溯源边：拆批 父->子；合批 来源->目标
  const downstream = new Map();

  for (const event of [...events].sort(compareByOccurredAt)) {
    apply(event);
  }

  function addEdge(from, to) {
    if (!downstream.has(from)) downstream.set(from, []);
    const list = downstream.get(from);
    if (!list.includes(to)) list.push(to);
  }

  function apply(event) {
    const s = event.data;
    switch (event.type) {
      case 'mother_registered': {
        mothers.set(event.streamId, {
          id: event.streamId,
          code: s.code,
          species: s.species,
          source: s.source,
          locationBaseId: s.locationBaseId,
          researcherId: s.researcherId,
          note: s.note ?? null,
          registeredAt: event.at,
          inspections: new Map(),
        });
        break;
      }
      case 'batch_registered': {
        batches.set(event.streamId, {
          id: event.streamId,
          label: s.label,
          species: s.species,
          motherPlantId: s.motherPlantId,
          nurseryBaseId: s.nurseryBaseId,
          registeredAt: event.at,
          initialQuantity: s.quantity,
          origin: s.origin ?? null,
          splits: [],
          mergedAway: [],
          transports: [],
          plantings: [],
          quarantines: [],
          quarantineLifts: [],
          inspections: new Map(),
        });
        if (s.origin?.type === 'split') addEdge(s.origin.parentBatchId, event.streamId);
        if (s.origin?.type === 'merge') {
          for (const source of s.origin.sources) addEdge(source.batchId, event.streamId);
        }
        break;
      }
      case 'batch_split': {
        const batch = batches.get(event.streamId);
        batch.splits.push({ childBatchId: s.childBatchId, childLabel: s.childLabel, quantity: s.quantity, at: event.at });
        addEdge(event.streamId, s.childBatchId);
        break;
      }
      case 'batch_merged_away': {
        const batch = batches.get(event.streamId);
        batch.mergedAway.push({ targetBatchId: s.targetBatchId, quantity: s.quantity, at: event.at });
        addEdge(event.streamId, s.targetBatchId);
        break;
      }
      case 'transported': {
        batches.get(event.streamId).transports.push({
          fromBaseId: s.fromBaseId,
          toBaseId: s.toBaseId,
          carrier: s.carrier,
          waybill: s.waybill,
          at: event.at,
          deviceId: event.deviceId ?? null,
          eventId: event.id,
        });
        break;
      }
      case 'planted': {
        batches.get(event.streamId).plantings.push({
          forestBaseId: s.forestBaseId,
          plotId: s.plotId,
          quantity: s.quantity,
          farmerId: s.farmerId,
          at: event.at,
          deviceId: event.deviceId ?? null,
          eventId: event.id,
        });
        break;
      }
      case 'inspection_recorded': {
        const subject = s.subject === 'mother' ? mothers.get(event.streamId) : batches.get(event.streamId);
        subject.inspections.set(s.inspectionId, {
          inspectionId: s.inspectionId,
          subject: s.subject,
          initialResult: s.result,
          currentResult: s.result,
          inspector: s.inspector,
          lab: s.lab,
          reportNo: s.reportNo,
          at: event.at,
          recordEventId: event.id,
          corrections: [],
        });
        break;
      }
      case 'inspection_corrected': {
        const subject = lookupSubject(s.subject, event.streamId);
        const inspection = subject.inspections.get(s.inspectionId);
        inspection.corrections.push({
          correctedResult: s.correctedResult,
          reason: s.reason,
          correctedBy: s.correctedBy,
          at: event.at,
          eventId: event.id,
        });
        // 当前有效结论取最后一次更正；原始记录与历次更正均保留
        inspection.currentResult = s.correctedResult;
        break;
      }
      case 'batch_quarantined': {
        batches.get(event.streamId).quarantines.push({ recallId: s.recallId, reason: s.reason, at: event.at });
        break;
      }
      case 'batch_quarantine_lifted': {
        batches.get(event.streamId).quarantineLifts.push({ recallId: s.recallId, at: event.at });
        break;
      }
      case 'recall_issued': {
        recalls.set(event.streamId, {
          id: event.streamId,
          rootBatchId: s.rootBatchId,
          reason: s.reason,
          triggerInspectionId: s.triggerInspectionId ?? null,
          issuedAt: event.at,
          issuedBy: event.actor?.id ?? null,
          snapshot: s.impactSnapshot,
          notifications: new Map(),
          closedAt: null,
          closeReason: null,
        });
        break;
      }
      case 'notification_recorded': {
        const recall = recalls.get(event.streamId);
        if (!recall.notifications.has(s.recipientId)) {
          recall.notifications.set(s.recipientId, {
            recipientId: s.recipientId,
            recipientKind: s.recipientKind,
            channel: s.channel,
            at: event.at,
            eventId: event.id,
          });
        }
        break;
      }
      case 'recall_closed': {
        const recall = recalls.get(event.streamId);
        recall.closedAt = event.at;
        recall.closeReason = s.reason;
        break;
      }
      default:
        break;
    }
  }

  function lookupSubject(subject, streamId) {
    return subject === 'mother' ? mothers.get(streamId) : batches.get(streamId);
  }

  return { mothers, batches, recalls, downstream };
}

function compareByOccurredAt(a, b) {
  if (a.at === b.at) return a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0;
  return a.at < b.at ? -1 : 1;
}

// ---------- 派生读数 ----------

export function availableQuantity(batch) {
  const out = batch.splits.reduce((sum, x) => sum + x.quantity, 0);
  const merged = batch.mergedAway.reduce((sum, x) => sum + x.quantity, 0);
  const planted = batch.plantings.reduce((sum, x) => sum + x.quantity, 0);
  return batch.initialQuantity - out - merged - planted;
}

export function currentLocation(batch) {
  if (batch.transports.length === 0) {
    return { baseId: batch.nurseryBaseId, kind: 'nursery', since: batch.registeredAt };
  }
  const last = batch.transports[batch.transports.length - 1];
  return { baseId: last.toBaseId, kind: 'base', since: last.at };
}

export function isQuarantined(batch, recallId = null) {
  const active = batch.quarantines.filter((q) => {
    if (recallId && q.recallId !== recallId) return false;
    return !batch.quarantineLifts.some((l) => l.recallId === q.recallId && l.at >= q.at);
  });
  return active.length > 0;
}

// 沿 拆批/合批 边向下游收集（含起点）
export function downstreamBatches(state, rootBatchId) {
  const result = new Set([rootBatchId]);
  const queue = [rootBatchId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const child of state.downstream.get(current) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}

// 批次当前是否存在有效结论为“不合格”的检验
export function hasUnqualifiedInspection(batch) {
  for (const inspection of batch.inspections.values()) {
    if (inspection.currentResult === 'unqualified') return true;
  }
  return false;
}

// 影响范围：批次集合、定植点、在田数量、剩余可用数量、涉及农户
export function impactOf(state, rootBatchId) {
  const batchIds = downstreamBatches(state, rootBatchId);
  const plotKeys = new Set();
  const plots = [];
  const farmerIds = new Set();
  let plantedQuantity = 0;
  let available = 0;
  const quarantined = [];

  for (const id of batchIds) {
    const batch = state.batches.get(id);
    if (!batch) continue;
    available += availableQuantity(batch);
    if (isQuarantined(batch)) quarantined.push(id);
    for (const planting of batch.plantings) {
      plantedQuantity += planting.quantity;
      farmerIds.add(planting.farmerId);
      const key = `${planting.forestBaseId}:${planting.plotId}`;
      if (!plotKeys.has(key)) {
        plotKeys.add(key);
        plots.push({
          forestBaseId: planting.forestBaseId,
          plotId: planting.plotId,
          farmerId: planting.farmerId,
          quantity: 0,
          batchIds: [],
        });
      }
      const plot = plots.find((p) => p.forestBaseId === planting.forestBaseId && p.plotId === planting.plotId);
      plot.quantity += planting.quantity;
      plot.batchIds.push(id);
    }
  }

  return {
    rootBatchId,
    batchIds: [...batchIds],
    plots,
    farmerIds: [...farmerIds],
    plantedQuantity,
    remainingAvailableQuantity: available,
    quarantinedBatchIds: quarantined,
  };
}
