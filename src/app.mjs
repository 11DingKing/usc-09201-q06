import { Ledger, EVENT_TYPES, VERDICTS } from './domain/ledger.mjs';
import { TraceService } from './domain/trace.mjs';
import { Directory, ROLES } from './domain/directory.mjs';
import { AccessError, ValidationError } from './domain/errors.mjs';

// 写事件的角色权限矩阵：谁能登记哪类事实。
const WRITE_ROLES = Object.freeze({
  [EVENT_TYPES.MOTHER_REGISTERED]: [ROLES.RESEARCHER, ROLES.COORDINATOR],
  [EVENT_TYPES.BATCH_GERMINATED]: [ROLES.BASE_OPERATOR, ROLES.COORDINATOR],
  [EVENT_TYPES.BATCH_SPLIT]: [ROLES.BASE_OPERATOR, ROLES.COORDINATOR],
  [EVENT_TYPES.BATCH_MERGED]: [ROLES.BASE_OPERATOR, ROLES.COORDINATOR],
  [EVENT_TYPES.INSPECTION_RECORDED]: [ROLES.INSPECTOR, ROLES.COORDINATOR],
  [EVENT_TYPES.INSPECTION_CORRECTED]: [ROLES.INSPECTOR, ROLES.COORDINATOR],
  [EVENT_TYPES.TRANSPORT_DISPATCHED]: [ROLES.BASE_OPERATOR, ROLES.COORDINATOR],
  [EVENT_TYPES.TRANSPORT_RECEIVED]: [ROLES.BASE_OPERATOR, ROLES.COORDINATOR],
  [EVENT_TYPES.PLANTING_RECORDED]: [ROLES.BASE_OPERATOR, ROLES.COORDINATOR],
  [EVENT_TYPES.QUARANTINE_ORDERED]: [ROLES.INSPECTOR, ROLES.COORDINATOR, ROLES.BASE_OPERATOR],
  [EVENT_TYPES.STOCK_DESTROYED]: [ROLES.INSPECTOR, ROLES.COORDINATOR],
  [EVENT_TYPES.RECALL_ISSUED]: [ROLES.COORDINATOR],
  [EVENT_TYPES.RECALL_NOTIFIED]: [ROLES.COORDINATOR],
  [EVENT_TYPES.RECALL_ACKNOWLEDGED]: [ROLES.BASE_OPERATOR, ROLES.COORDINATOR, ROLES.FARMER],
});

export class App {
  constructor({ eventStore, contactStore, researchStore, now = () => new Date() } = {}) {
    this.eventStore = eventStore;
    this.contactStore = contactStore;
    this.researchStore = researchStore;
    this.ledger = new Ledger({ now });
    this.directory = new Directory();
    this.trace = new TraceService(this.ledger, this.directory);
    this._now = now;
  }

  async init() {
    await this.eventStore.init();
    await this.contactStore.init();
    await this.researchStore.init();
    this.ledger.load(await this.eventStore.readAll());
    for (const [farmerId, record] of Object.entries(this.contactStore.get('contacts', {}))) {
      this.directory.contactsById.set(farmerId, record);
    }
    for (const [motherBatchId, notes] of Object.entries(this.researchStore.get('notes', {}))) {
      this.directory.researchByMother.set(motherBatchId, notes);
    }
  }

  actorFrom(headers) {
    const id = headers['x-user-id'];
    const role = headers['x-user-role'];
    if (!id || !role) {
      throw new AccessError('缺少身份头 x-user-id / x-user-role', 'unauthenticated', 401);
    }
    if (!Object.values(ROLES).includes(role)) {
      throw new AccessError(`未知角色：${role}`);
    }
    return { id, role, baseId: headers['x-base-id'] ?? null };
  }

  requireEventRole(actor, type) {
    const allowed = WRITE_ROLES[type];
    if (!allowed) throw new ValidationError(`未知事件类型：${type}`);
    if (!allowed.includes(actor.role)) {
      throw new AccessError(`角色 ${actor.role} 无权登记事件 ${type}`);
    }
  }

  // 单事件追加；支持离线补录（body.at 为真实发生时间，recordedAt 由服务端盖戳）。
  async appendEvent(input, actor) {
    this.requireEventRole(actor, input.type);
    const result = this.ledger.append(input, { actor });
    if (!result.deduplicated) await this.eventStore.append(result.event);
    return result;
  }

  // 离线批量同步：整组暂存、一次校验，乱序到达也可生效；任一不合法整体回滚。
  async appendBatch(items, actor) {
    const list = items.events ?? items;
    if (!Array.isArray(list) || list.length === 0) {
      throw new ValidationError('批量事件必须为非空数组');
    }
    for (const item of list) this.requireEventRole(actor, item.type);
    const staged = this.ledger.appendMany(list, { actor });
    const fresh = staged.filter((result) => !result.deduplicated).map((result) => result.event);
    await this.eventStore.appendMany(fresh);
    return staged;
  }

  // 研究数据（仅 researcher / coordinator）。
  async putResearchNote(motherBatchId, body, actor) {
    if (actor.role !== ROLES.RESEARCHER && actor.role !== ROLES.COORDINATOR) {
      throw new AccessError('研究数据仅对研究人员开放');
    }
    if (!this.ledger.getBatch(motherBatchId)) throw new ValidationError(`母本批次不存在：${motherBatchId}`);
    const note = this.directory.putResearchNote(motherBatchId, {
      researcherId: actor.id,
      at: body.at ?? this._now().toISOString(),
      content: body.content ?? '',
      tags: body.tags ?? [],
    });
    await this.researchStore.set('notes', Object.fromEntries(this.directory.researchByMother));
    return note;
  }

  listResearchNotes(motherBatchId, actor) {
    return this.directory.viewResearch(actor, motherBatchId);
  }

  // 农户联系方式（coordinator 全权；base_operator 限本基地；其他角色脱敏）。
  async upsertContact(body, actor) {
    if (actor.role !== ROLES.COORDINATOR
      && !(actor.role === ROLES.BASE_OPERATOR && body.baseId === actor.baseId)) {
      throw new AccessError('无权登记农户联系方式');
    }
    const record = this.directory.upsertContact(body);
    await this.contactStore.set('contacts', Object.fromEntries(this.directory.contactsById));
    return record;
  }

  viewContacts(actor, farmerIds) {
    return this.directory.viewContacts(actor, farmerIds);
  }

  batchView(batchId, actor) {
    const batch = this.ledger.getBatch(batchId);
    if (!batch) return null;
    const view = { ...batch };
    // 基地操作员只能看本基地批次的细项；跨基地仍可在影响分析中看到编号与数量。
    if (actor.role === ROLES.BASE_OPERATOR && actor.baseId
      && batch.currentBaseId !== actor.baseId && batch.baseId !== actor.baseId) {
      return {
        batchId: batch.batchId,
        label: batch.label,
        currentBaseId: batch.currentBaseId,
        status: batch.status,
        onHand: batch.onHand,
        crossBase: true,
      };
    }
    view.effectiveInspection = this.ledger.effectiveInspection(batchId);
    return view;
  }
}

export { EVENT_TYPES, VERDICTS, ROLES };
