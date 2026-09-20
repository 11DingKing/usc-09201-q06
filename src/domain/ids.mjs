// 标识生成：前缀 + 时间 + 进程内自增序列 + 随机段，避免离线设备之间碰撞
let sequence = 0;

export function newId(prefix) {
  sequence += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${sequence.toString(36)}${random}`;
}
