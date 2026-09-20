import { NotFoundError, AccessError } from './errors.mjs';

// 分权数据分区：
// - research：母本与育苗研究数据，仅 researcher / coordinator 可读；
// - contacts：农户与站点联系方式，仅 coordinator 及同基地 base_operator 可读；
// - inspector 只能接触检验结论，看不到联系方式与研究记录。
// 追踪链本身（批次、数量、事件）对以上角色开放，敏感字段在视图层按角色脱敏。

const ROLES = Object.freeze({
  RESEARCHER: 'researcher',
  INSPECTOR: 'inspector',
  BASE_OPERATOR: 'base_operator',
  COORDINATOR: 'coordinator', // 产业联合体调度
  FARMER: 'farmer',           // 农户（仅可确认收到召回通知）
});

export class Directory {
  constructor() {
    this.contactsById = new Map();
    this.researchByMother = new Map();
  }

  upsertContact(contact) {
    if (!contact?.farmerId) throw new NotFoundError('农户记录缺少 farmerId');
    const record = {
      farmerId: contact.farmerId,
      name: contact.name ?? '',
      phone: contact.phone ?? null,
      baseId: contact.baseId ?? null,
      siteIds: contact.siteIds ?? [],
    };
    this.contactsById.set(record.farmerId, record);
    return record;
  }

  putResearchNote(motherBatchId, note) {
    if (!note?.researcherId || !note?.at) {
      throw new NotFoundError('研究记录需要 researcherId 与 at');
    }
    const list = this.researchByMother.get(motherBatchId) ?? [];
    list.push({ ...note, motherBatchId });
    this.researchByMother.set(motherBatchId, list);
    return list[list.length - 1];
  }

  // 按角色返回联系方式；无权时字段脱敏而不是报错，保证追踪链可用、敏感数据不外泄。
  viewContacts(actor, farmerIds) {
    const allowedContact = (farmerId) => {
      const record = this.contactsById.get(farmerId);
      if (!record) return { farmerId, found: false };
      const role = actor?.role;
      if (role === ROLES.COORDINATOR) return { ...record, found: true };
      if (role === ROLES.BASE_OPERATOR && actor.baseId && record.baseId === actor.baseId) {
        return { ...record, found: true };
      }
      // researcher / inspector / 跨基地 operator：只回编号
      return { farmerId, found: true, name: null, phone: null, baseId: record.baseId, masked: true };
    };
    return [...new Set(farmerIds)].map(allowedContact);
  }

  requireContactAccess(actor, farmerId) {
    const record = this.contactsById.get(farmerId);
    if (!record) throw new NotFoundError(`农户不存在：${farmerId}`);
    if (actor?.role === ROLES.COORDINATOR) return record;
    if (actor?.role === ROLES.BASE_OPERATOR && actor.baseId === record.baseId) return record;
    throw new AccessError('无权访问该农户联系方式');
  }

  viewResearch(actor, motherBatchId) {
    if (actor?.role !== ROLES.RESEARCHER && actor?.role !== ROLES.COORDINATOR) {
      throw new AccessError('研究数据仅对研究人员开放');
    }
    return this.researchByMother.get(motherBatchId) ?? [];
  }
}

export { ROLES };
