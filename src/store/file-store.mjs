import { promises as fs } from 'node:fs';
import path from 'node:path';

// 事件存储：JSONL 追加日志。事实只追加、不改写；
// 研究数据与农户联系方式分别保存在独立分区文件，便于按职责授权访问。
export class JsonlEventStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, '', { flag: 'a' });
  }

  async readAll() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const events = [];
    for (const [index, line] of raw.split('\n').entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch (error) {
        throw new Error(`事件日志第 ${index + 1} 行损坏：${error.message}`);
      }
    }
    return events;
  }

  async append(event) {
    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async appendMany(events) {
    if (events.length === 0) return;
    await fs.appendFile(this.filePath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  }
}

// 简单 JSON 文档分区：研究数据、联系方式各占一个文件，物理上分权保存。
export class JsonPartitionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {};
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.data = raw.trim() ? JSON.parse(raw) : {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = {};
    }
  }

  get(key, fallback = null) {
    return this.data[key] ?? fallback;
  }

  async set(key, value) {
    this.data[key] = value;
    await this._flush();
  }

  async update(key, producer, fallback) {
    this.data[key] = producer(this.data[key] ?? fallback);
    await this._flush();
    return this.data[key];
  }

  async _flush() {
    const target = this.filePath;
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await fs.rename(tmp, target);
  }
}
