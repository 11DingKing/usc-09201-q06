import { EventStore } from './eventStore.mjs';
import { newId } from './ids.mjs';
import { ValidationError, ConflictError, PermissionError, NotFoundError } from './errors.mjs';
import {
  foldEvents,
  availableQuantity,
  currentLocation,
  isQuarantined,
  downstreamBatches,
  impactOf,
} from './projection.mjs';

const ROLES = {
  admin: '*',
  researcher: ['mother:write', 'trace:read', 'research:read'],
  nursery_worker: ['batch:write', 'trace:read'],
  inspector: ['inspection:write', 'trace:read'],
  base_coordinator: ['planting:write', 'contacts:read', 'trace:read'],
  recall_officer: ['recall:write', 'trace:read', 'contacts:read'],
  auditor: ['trace:read'],
};

export class TraceabilityService {
  constructor({ store = new EventStore(), farmerDirectory = null, baseDirectory = null } = {}) {
    this.store = store;
    this.farmers = farmerDirectory;
    this.bases = baseDirectory;
  }

  // ---------- 母本 ----------

  registerMother(actor, command) {
    this.#allow(actor, 'mother:write');
    const state = this.#state();
    const code = requireString(command.code, '母本编号');
    for (const mother of state.mothers.values()) {
      if (mother.code === code) throw new ConflictError(`母本编号 ${code} 已存在，标签不得重复`);
    }
    const id = command.id ?? newId('mother');
    return this.store.append({
      streamId: id,
      type: 'mother_registered',
      at: this.#occurredAt(command),
      actor: { id: actor.id, role: actor.role },
      idempotencyKey: command.idempotencyKey,
      data: {
        code,
        species: requireString(command.species, '物种'),
        source: command.source ?? null,
        locationBaseId: command.locationBaseId ?? null,
        researcherId: command.researcherId ?? actor.id,
        note: command.note ?? null,
      },
    });
  }

  // ---------- 育苗批 ----------

  registerBatch(actor, command) {
    this.#allow(actor, 'batch:write');
    const state = this.#state();
    this.#requireFreeLabel(state, command.label);
    const mother = this.#requireMother(state, command.motherPlantId);
    const quantity = requirePositiveInteger(command.quantity, '数量');
    const id = command.id ?? newId('batch');
    return this.store.append({
      streamId: id,
      type: 'batch_registered',
      at: this.#occurredAt(command),
      actor: { id: actor.id, role: actor.role },
      id: command.eventId,
      idempotencyKey: command.idempotencyKey,
      deviceId: command.deviceId,
      data: {
        label: command.label,
        species: command.species ?? mother.species,
        motherPlantId: mother.id,
        nurseryBaseId: requireString(command.nurseryBaseId, '育苗基地'),
        quantity,
        origin: null,
      },
    });
  }

  // 拆批：从父批划出数量形成新批，父批剩余可用数量相应减少
  splitBatch(actor, command) {
    this.#allow(actor, 'batch:write');
    const state = this.#state();
    const parent = this.#requireBatch(state, command.batchId);
    const quantity = requirePositiveInteger(command.quantity, '拆分数量');
    const remaining = availableQuantity(parent);
    if (quantity > remaining) {
      throw new ValidationError(`拆分数量 ${quantity} 超过批次 ${parent.label} 剩余可用数量 ${remaining}`);
    }
    this.#requireFreeLabel(state, command.childLabel);

    const childId = command.childBatchId ?? newId('batch');
    const at = this.#occurredAt(command);
    this.#requireNotBeforeRegistration(at, parent, '拆分');
    const actorInfo = { id: actor.id, role: actor.role };
    this.store.append({
      streamId: childId,
      type: 'batch_registered',
      at,
      actor: actorInfo,
      data: {
        label: command.childLabel,
        species: parent.species,
        motherPlantId: parent.motherPlantId,
        nurseryBaseId: currentLocation(parent).baseId,
        quantity,
        origin: { type: 'split', parentBatchId: parent.id, parentLabel: parent.label, quantity },
      },
    });
    const splitEvent = this.store.append({
      streamId: parent.id,
      type: 'batch_split',
      at,
      actor: actorInfo,
      idempotencyKey: command.idempotencyKey,
      data: { childBatchId: childId, childLabel: command.childLabel, quantity },
    });
    return { splitEvent, childBatchId: childId };
  }

  // 合批：多个来源批次各划出指定数量，合并为新批次
  mergeBatches(actor, command) {
    this.#allow(actor, 'batch:write');
    const state = this.#state();
    const entries = command.sources ?? [];
    if (entries.length < 2) throw new ValidationError('合批至少需要两个来源批次');
    this.#requireFreeLabel(state, command.targetLabel);

    const at = this.#occurredAt(command);
    const actorInfo = { id: actor.id, role: actor.role };
    let total = 0;
    let motherPlantId = null;
    let nurseryBaseId = null;
    for (const entry of entries) {
      const source = this.#requireBatch(state, entry.batchId);
      this.#requireNotBeforeRegistration(at, source, '合批');
      const quantity = requirePositiveInteger(entry.quantity, '合批数量');
      if (quantity > availableQuantity(source)) {
        throw new ValidationError(`合批数量 ${quantity} 超过批次 ${source.label} 剩余可用数量 ${availableQuantity(source)}`);
      }
      if (motherPlantId && motherPlantId !== source.motherPlantId) {
        throw new ValidationError('仅允许同一母本来源的批次合批，以免污染种源谱系');
      }
      motherPlantId = source.motherPlantId;
      nurseryBaseId = currentLocation(source).baseId;
      total += quantity;
    }

    const targetId = command.targetBatchId ?? newId('batch');
    this.store.append({
      streamId: targetId,
      type: 'batch_registered',
      at,
      actor: actorInfo,
      data: {
        label: command.targetLabel,
        species: state.batches.get(entries[0].batchId).species,
        motherPlantId,
        nurseryBaseId,
        quantity: total,
        origin: {
          type: 'merge',
          sources: entries.map((e) => ({ batchId: e.batchId, quantity: e.quantity })),
        },
      },
    });
    for (const entry of entries) {
      this.store.append({
        streamId: entry.batchId,
        type: 'batch_merged_away',
        at,
        actor: actorInfo,
        data: { targetBatchId: targetId, targetLabel: command.targetLabel, quantity: entry.quantity },
      });
    }
    return targetId;
  }

  // ---------- 检验与更正 ----------

  recordInspection(actor, command) {
    this.#allow(actor, 'inspection:write');
    const state = this.#state();
    const subject = this.#requireSubject(state, command.subject, command.streamId);
    const result = requireResult(command.result);
    const inspectionId = command.inspectionId ?? newId('insp');
    const at = this.#occurredAt(command);
    this.#requireNotBeforeRegistration(at, subject, '检验');
    return this.store.append({
      streamId: command.streamId,
      type: 'inspection_recorded',
      at: this.#occurredAt(command),
      actor: { id: actor.id, role: actor.role },
      // 离线设备可自带事件 id 与幂等键，补传不产生重复事实
      id: command.eventId,
      idempotencyKey: command.idempotencyKey,
      deviceId: command.deviceId,
      data: {
        inspectionId,
        subject: command.subject ?? 'batch',
        result,
        inspector: command.inspector ?? actor.id,
        lab: requireString(command.lab, '检测机构'),
        reportNo: command.reportNo ?? null,
      },
    });
  }

  // 检测结果更正：不修改原记录，追加更正事件；当前有效结论以最后一次更正为准
  correctInspection(actor, command) {
    this.#allow(actor, 'inspection:write');
    const state = this.#state();
    const subject = this.#requireSubject(state, command.subject, command.streamId);
    const inspection = subject.inspections.get(command.inspectionId);
    if (!inspection) throw new NotFoundError(`检验 ${command.inspectionId} 不存在`);
    const correctedResult = requireResult(command.correctedResult);
    if (correctedResult === inspection.currentResult) {
      throw new ValidationError('更正结论与当前有效结论相同，无需更正');
    }
    const at = this.#occurredAt(command);
    this.#requireNotBeforeRegistration(at, subject, '检验更正');
    return this.store.append({
      streamId: command.streamId,
      type: 'inspection_corrected',
      at: this.#occurredAt(command),
      actor: { id: actor.id, role: actor.role },
      idempotencyKey: command.idempotencyKey,
      data: {
        inspectionId: command.inspectionId,
        subject: command.subject ?? 'batch',
        correctedResult,
        reason: requireString(command.reason, '更正原因'),
        correctedBy: actor.id,
      },
    });
  }

  // ---------- 转运与定植 ----------

  transport(actor, command) {
    this.#allow(actor, 'batch:write');
    const state = this.#state();
    const batch = this.#requireBatch(state, command.batchId);
    const fromBaseId = requireString(command.fromBaseId, '调出基地');
    const toBaseId = requireString(command.toBaseId, '调入基地');
    if (fromBaseId === toBaseId) throw new ValidationError('调出基地与调入基地相同');
    const at = this.#occurredAt(command);
    this.#requireNotBeforeRegistration(at, batch, '转运');
    const loc = currentLocation(batch);
    // 跨基地调拨是已发生事实：以单据记载的调出地为准，仅在与当前所在地不一致时提示，不阻断补录
    if (loc.baseId !== fromBaseId) {
      // 允许离线乱序补录，但要求提供运单号以便核验链条
      if (!command.waybill) {
        throw new ConflictError(`批次当前位于 ${loc.baseId}，与调出地 ${fromBaseId} 不一致；跨基地调拨需提供运单号`);
      }
    }
    return this.store.append({
      streamId: batch.id,
      type: 'transported',
      at: this.#occurredAt(command),
      actor: { id: actor.id, role: actor.role },
      id: command.eventId,
      idempotencyKey: command.idempotencyKey,
      deviceId: command.deviceId,
      data: { fromBaseId, toBaseId, carrier: command.carrier ?? null, waybill: command.waybill ?? null },
    });
  }

  plant(actor, command) {
    this.#allow(actor, 'planting:write');
    const state = this.#state();
    const batch = this.#requireBatch(state, command.batchId);
    const quantity = requirePositiveInteger(command.quantity, '定植数量');
    if (quantity > availableQuantity(batch)) {
      throw new ValidationError(`定植数量 ${quantity} 超过批次 ${batch.label} 剩余可用数量 ${availableQuantity(batch)}`);
    }
    if (isQuarantined(batch)) throw new ConflictError(`批次 ${batch.label} 已被隔离，不得定植`);
    const at = this.#occurredAt(command);
    this.#requireNotBeforeRegistration(at, batch, '定植');
    return this.store.append({
      streamId: batch.id,
      type: 'planted',
      at: this.#occurredAt(command),
      actor: { id: actor.id, role: actor.role },
      id: command.eventId,
      idempotencyKey: command.idempotencyKey,
      deviceId: command.deviceId,
      data: {
        forestBaseId: requireString(command.forestBaseId, '林地基地'),
        plotId: requireString(command.plotId, '地块'),
        quantity,
        farmerId: requireString(command.farmerId, '农户标识'),
      },
    });
  }

  // ---------- 定向召回 ----------

  issueRecall(actor, command) {
    this.#allow(actor, 'recall:write');
    const state = this.#state();
    const root = this.#requireBatch(state, command.rootBatchId);
    const impact = impactOf(state, root.id);
    const trigger = command.triggerInspectionId
      ? this.#findInspection(state, command.triggerInspectionId)
      : null;

    const recallId = command.recallId ?? newId('recall');
    const at = this.#occurredAt(command);
    const actorInfo = { id: actor.id, role: actor.role };

    this.store.append({
      streamId: recallId,
      type: 'recall_issued',
      at,
      actor: actorInfo,
      idempotencyKey: command.idempotencyKey,
      data: {
        rootBatchId: root.id,
        rootLabel: root.label,
        reason: requireString(command.reason, '召回原因'),
        triggerInspectionId: trigger?.inspectionId ?? null,
        // 签发时刻的影响范围快照（已发生事实的固定留档）
        impactSnapshot: serializeImpact(impact),
      },
    });

    // 沿种源链冻结全部下游批次
    for (const batchId of impact.batchIds) {
      this.store.append({
        streamId: batchId,
        type: 'batch_quarantined',
        at,
        actor: actorInfo,
        data: { recallId, reason: command.reason },
      });
    }

    this.#notifyRecipients(actorInfo, recallId, impact, at, command.channels ?? { default: 'sms' }, state);
    return { recallId, impact };
  }

  // 影响范围扩大后（如补录新的定植）同步通知：已通知对象自动去重，只通知新增对象
  syncRecallNotifications(actor, recallId, channels = { default: 'sms' }) {
    this.#allow(actor, 'recall:write');
    const state = this.#state();
    const recall = state.recalls.get(recallId);
    if (!recall) throw new NotFoundError(`召回 ${recallId} 不存在`);
    const impact = impactOf(state, recall.rootBatchId);
    const at = new Date().toISOString();
    this.#notifyRecipients({ id: actor.id, role: actor.role }, recallId, impact, at, channels, state);
    return this.#recallView(state, recallId);
  }

  #notifyRecipients(actorInfo, recallId, impact, at, channels, state = this.#state()) {
    const recipients = new Map();
    for (const farmerId of impact.farmerIds) {
      recipients.set(`farmer:${farmerId}`, { id: farmerId, kind: 'farmer' });
    }
    for (const plot of impact.plots) {
      const base = this.bases?.get(plot.forestBaseId);
      if (base?.coordinatorFarmerId && !recipients.has(`coordinator:${base.coordinatorFarmerId}`)) {
        recipients.set(`coordinator:${base.coordinatorFarmerId}`, {
          id: base.coordinatorFarmerId,
          kind: 'base_coordinator',
        });
      }
    }
    // 仍在手上的库存批次，通知当前持有基地的协调员
    if (impact.remainingAvailableQuantity > 0) {
      for (const batchId of impact.batchIds) {
        const batch = state.batches.get(batchId);
        if (!batch || availableQuantity(batch) <= 0) continue;
        const base = this.bases?.get(currentLocation(batch).baseId);
        if (base?.coordinatorFarmerId) {
          recipients.set(`coordinator:${base.coordinatorFarmerId}`, {
            id: base.coordinatorFarmerId,
            kind: 'base_coordinator',
          });
        }
      }
    }

    for (const recipient of recipients.values()) {
      this.store.append({
        streamId: recallId,
        type: 'notification_recorded',
        at,
        actor: actorInfo,
        // 幂等键同时含召回与接收人，跨次同步天然去重
        idempotencyKey: `notify:${recallId}:${recipient.kind}:${recipient.id}`,
        data: {
          recipientId: recipient.id,
          recipientKind: recipient.kind,
          channel: channels[recipient.kind] ?? channels.default ?? 'sms',
        },
      });
    }
  }

  closeRecall(actor, recallId, reason) {
    this.#allow(actor, 'recall:write');
    const state = this.#state();
    const recall = state.recalls.get(recallId);
    if (!recall) throw new NotFoundError(`召回 ${recallId} 不存在`);
    const at = new Date().toISOString();
    for (const batchId of recall.snapshot.batchIds) {
      const batch = state.batches.get(batchId);
      if (batch && isQuarantined(batch, recallId)) {
        this.store.append({
          streamId: batchId,
          type: 'batch_quarantine_lifted',
          at,
          actor: { id: actor.id, role: actor.role },
          data: { recallId },
        });
      }
    }
    return this.store.append({
      streamId: recallId,
      type: 'recall_closed',
      at,
      actor: { id: actor.id, role: actor.role },
      data: { reason: requireString(reason, '关闭原因') },
    });
  }

  // ---------- 查询 ----------

  getBatch(actor, batchId) {
    this.#allow(actor, 'trace:read');
    const state = this.#state();
    const batch = this.#requireBatch(state, batchId);
    const mother = state.mothers.get(batch.motherPlantId) ?? null;
    return {
      id: batch.id,
      label: batch.label,
      species: batch.species,
      mother: mother && {
        id: mother.id,
        code: mother.code,
        source: mother.source,
        // 研究备注等研究数据仅对研究相关角色开放
        ...(this.#can(actor, 'research:read') ? { note: mother.note, researcherId: mother.researcherId } : {}),
      },
      nurseryBaseId: batch.nurseryBaseId,
      registeredAt: batch.registeredAt,
      initialQuantity: batch.initialQuantity,
      availableQuantity: availableQuantity(batch),
      location: currentLocation(batch),
      origin: batch.origin,
      splits: batch.splits,
      transports: batch.transports,
      plantings: batch.plantings,
      quarantined: isQuarantined(batch),
      inspections: [...batch.inspections.values()],
    };
  }

  // 反查：批次 -> 母本、育苗条件、分发去向
  trace(actor, batchId) {
    this.#allow(actor, 'trace:read');
    const state = this.#state();
    this.#requireBatch(state, batchId);
    const down = [...downstreamBatches(state, batchId)].filter((id) => id !== batchId);
    return {
      batchId,
      downstream: down.map((id) => this.getBatch(actor, id)),
    };
  }

  getRecall(actor, recallId) {
    this.#allow(actor, 'trace:read');
    return this.#recallView(this.#state(), recallId, actor);
  }

  #recallView(state, recallId, actor = null) {
    const recall = state.recalls.get(recallId);
    if (!recall) throw new NotFoundError(`召回 ${recallId} 不存在`);
    const liveImpact = impactOf(state, recall.rootBatchId);
    const notifications = [...recall.notifications.values()];
    return {
      id: recall.id,
      rootBatchId: recall.rootBatchId,
      reason: recall.reason,
      triggerInspectionId: recall.triggerInspectionId,
      issuedAt: recall.issuedAt,
      closedAt: recall.closedAt,
      snapshot: recall.snapshot,
      liveImpact: serializeImpact(liveImpact),
      notificationCount: notifications.length,
      notifications: actor && this.#can(actor, 'contacts:read')
        ? notifications.map((n) => ({ ...n, contact: this.farmers?.contactOf(n.recipientId) ?? null }))
        : notifications.map(({ recipientId, recipientKind, channel, at }) => ({
            recipientId,
            recipientKind,
            channel,
            at,
            contact: actor ? 'redacted' : undefined,
          })),
    };
  }

  history(actor, streamId) {
    this.#allow(actor, 'trace:read');
    const events = this.store.stream(streamId);
    if (events.length === 0) throw new NotFoundError(`流 ${streamId} 不存在`);
    // 原始事件只读返回；检测更正、标签重复等均以追加事件留痕
    return events.map(({ id, type, at, recordedAt, actor: a, deviceId, data }) => ({
      id, type, at, recordedAt, actor: a, deviceId, data,
    }));
  }

  // ---------- 内部工具 ----------

  #state() {
    return foldEvents(this.store.all());
  }

  #allow(actor, permission) {
    if (!actor?.role) throw new PermissionError('缺少执行身份');
    if (actor.role === 'admin') return;
    const perms = ROLES[actor.role];
    if (!perms || !perms.includes(permission)) {
      throw new PermissionError(`角色 ${actor.role} 无权执行 ${permission}`);
    }
  }

  #can(actor, permission) {
    if (!actor?.role) return false;
    if (actor.role === 'admin') return true;
    return (ROLES[actor.role] ?? []).includes(permission);
  }

  #occurredAt(command) {
    return command.at ?? new Date().toISOString();
  }

  // 已发生事实的发生时间不得早于其主体的建立时间（如批次登记之前不可能有该批的检验）
  #requireNotBeforeRegistration(at, subject, label) {
    if (at < subject.registeredAt) {
      throw new ValidationError(`${label}发生时间 ${at} 早于登记时间 ${subject.registeredAt}`);
    }
  }

  #requireFreeLabel(state, label) {
    const value = requireString(label, '批次标签');
    for (const batch of state.batches.values()) {
      if (batch.label === value) throw new ConflictError(`批次标签 ${value} 已被占用，标签不得重复`);
    }
  }

  #requireMother(state, id) {
    const mother = state.mothers.get(id);
    if (!mother) throw new NotFoundError(`母本 ${id} 不存在`);
    return mother;
  }

  #requireBatch(state, id) {
    const batch = state.batches.get(id);
    if (!batch) throw new NotFoundError(`批次 ${id} 不存在`);
    return batch;
  }

  #requireSubject(state, subject, streamId) {
    const kind = subject ?? 'batch';
    if (kind === 'mother') return this.#requireMother(state, streamId);
    if (kind === 'batch') return this.#requireBatch(state, streamId);
    throw new ValidationError(`未知检验对象类型 ${kind}`);
  }

  #findInspection(state, inspectionId) {
    for (const batch of state.batches.values()) {
      const found = batch.inspections.get(inspectionId);
      if (found) return found;
    }
    for (const mother of state.mothers.values()) {
      const found = mother.inspections.get(inspectionId);
      if (found) return found;
    }
    throw new NotFoundError(`检验 ${inspectionId} 不存在`);
  }
}

function serializeImpact(impact) {
  return {
    rootBatchId: impact.rootBatchId,
    batchIds: impact.batchIds,
    plots: impact.plots,
    farmerIds: impact.farmerIds,
    plantedQuantity: impact.plantedQuantity,
    remainingAvailableQuantity: impact.remainingAvailableQuantity,
    quarantinedBatchIds: impact.quarantinedBatchIds,
  };
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field}不能为空`);
  }
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field}必须为正整数`);
  }
  return value;
}

function requireResult(value) {
  if (!['qualified', 'unqualified'].includes(value)) {
    throw new ValidationError("检验结论只能是 qualified 或 unqualified");
  }
  return value;
}
