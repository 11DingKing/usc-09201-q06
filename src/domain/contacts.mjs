// 农户联系方式目录：与研究数据分权保存。
// 追溯事件里只出现 farmerId；姓名、电话等联系方式仅保存在本目录，
// 只有基地协调员（本基地）与召回管理员可以取用。
import { PermissionError } from './errors.mjs';

export class FarmerDirectory {
  constructor() {
    this.farmers = new Map();
  }

  upsert(actor, { farmerId, name, phone, baseId }) {
    requireRole(actor, ['base_coordinator', 'recall_officer', 'admin']);
    const existing = this.farmers.get(farmerId) ?? { farmerId, name: null, phone: null, baseIds: [] };
    if (name !== undefined) existing.name = name;
    if (phone !== undefined) existing.phone = phone;
    if (baseId && !existing.baseIds.includes(baseId)) existing.baseIds.push(baseId);
    this.farmers.set(farmerId, existing);
    return { farmerId, name: existing.name, baseIds: existing.baseIds };
  }

  // 解析通知对象的联系方式；无权角色得到脱敏结果
  resolve(actor, farmerIds) {
    const canView = actor.role === 'base_coordinator' || actor.role === 'recall_officer' || actor.role === 'admin';
    return farmerIds.map((id) => {
      const farmer = this.farmers.get(id);
      if (!farmer) return { farmerId: id, name: null, contactAvailable: false };
      if (!canView) return { farmerId: id, name: null, contactAvailable: Boolean(farmer.phone) };
      return { farmerId: id, name: farmer.name, phone: farmer.phone, contactAvailable: Boolean(farmer.phone) };
    });
  }

  contactOf(farmerId) {
    return this.farmers.get(farmerId) ?? null;
  }
}

// 基地目录：基地 -> 协调员，用于召回通知寻址
export class BaseDirectory {
  constructor() {
    this.bases = new Map();
  }

  registerBase({ baseId, name, kind, coordinatorFarmerId = null }) {
    this.bases.set(baseId, { baseId, name, kind, coordinatorFarmerId });
    return this.bases.get(baseId);
  }

  get(baseId) {
    return this.bases.get(baseId) ?? null;
  }
}

function requireRole(actor, roles) {
  if (!roles.includes(actor.role)) {
    const error = new Error(`角色 ${actor.role} 无权执行该操作`);
    error.name = 'PermissionError';
    throw error;
  }
}
