import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { newId } from './ids.mjs';

// 追加式事件存储：事件一旦写入不可修改、不可删除。
// 每个事件都是领域事实（fact），状态通过回放事件得到；
// “更正”通过追加新事件表达，旧事件原样保留。
export class EventStore {
  constructor() {
    this.events = [];
    // 幂等键 -> 已写入事件 id，防止重试 / 离线补传产生重复事实
    this.idempotencyKeys = new Map();
    // 标签一旦出现在任何批次事件中即被占用，防止标签重复
    this.usedLabels = new Set();
    // 事件 id -> 事件，便于离线设备带事件 id 补传时去重
    this.eventIds = new Set();
  }

  // 追加事件。event 结构：
  // { type, batchId, at, actor, data, id?, idempotencyKey?, deviceId?, recordedAt? }
  append(event) {
    if (this.idempotencyKeys.has(event.idempotencyKey)) {
      return this.events.find((e) => e.id === this.idempotencyKeys.get(event.idempotencyKey));
    }
    if (event.id && this.eventIds.has(event.id)) {
      return this.events.find((e) => e.id === event.id);
    }
    const stored = {
      id: event.id ?? newId('evt'),
      type: event.type,
      // 流标识：母本 id / 批次 id / 召回 id
      streamId: event.streamId ?? event.batchId,
      // 业务发生时间（可能是离线设备补传的过去时间）
      at: event.at,
      // 服务器接收时间，始终单调，用于稳定排序
      recordedAt: event.recordedAt ?? new Date().toISOString(),
      actor: event.actor,
      deviceId: event.deviceId ?? null,
      data: event.data ?? {},
    };
    this.events.push(stored);
    this.eventIds.add(stored.id);
    if (event.idempotencyKey) {
      this.idempotencyKeys.set(event.idempotencyKey, stored.id);
    }
    return stored;
  }

  // 登记被占用的批次标签（由投影在校验时调用）
  reserveLabel(label) {
    this.usedLabels.add(label);
  }

  isLabelUsed(label) {
    return this.usedLabels.has(label);
  }

  stream(streamId) {
    return this.events.filter((e) => e.streamId === streamId);
  }

  all() {
    return [...this.events];
  }

  // 按业务发生时间回放；同一时间以接收顺序为准，保证确定性
  replay(streamId) {
    return this.stream(streamId).sort((a, b) => {
      if (a.at === b.at) return this.events.indexOf(a) - this.events.indexOf(b);
      return a.at < b.at ? -1 : 1;
    });
  }

  async persist(filePath) {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await writeFile(filePath, JSON.stringify(this.events, null, 2), 'utf8');
  }

  static async load(filePath) {
    const store = new EventStore();
    if (existsSync(filePath)) {
      const raw = JSON.parse(await readFile(filePath, 'utf8'));
      for (const event of raw) {
        store.events.push(event);
        store.eventIds.add(event.id);
      }
    }
    return store;
  }
}
