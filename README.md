# 石斛种源追溯网

曲茎石斛种源追溯网：为母本、育苗批、检验结果、转运、定植建立不可变事件链，支持批次拆分合并、离线采集补传、检测结果更正、跨基地调拨、定向召回与通知去重。

## 运行

```bash
npm start          # 启动 HTTP 服务，默认端口 3000（PORT 可覆盖）
npm test           # 运行全部测试（含季末召回演练）
```

启动后访问 `/health` 确认服务状态。

## 架构

- `src/domain/eventStore.mjs` — 追加式事件存储（事件 id / 幂等键双键去重，标签占用登记）
- `src/domain/projection.mjs` — 纯函数投影：回放事件得到当前状态、剩余数量、影响范围
- `src/domain/traceService.mjs` — 应用服务：命令校验、RBAC、拆分合并、召回、通知去重
- `src/domain/contacts.mjs` — 农户联系方式与基地目录（与研究数据分权保存）
- `src/domain/errors.mjs` / `ids.mjs` — 受控错误与标识生成
- `src/http/app.mjs` — HTTP 路由（含 `/api/offline/sync` 离线重放）
- `test/drill.test.mjs` — 季末演练：拆批三处林地 → 补录不合格检测 → 核对影响范围与通知 → 定向召回

## HTTP 接口摘要

身份通过请求头 `x-actor-id`、`x-actor-role` 传递（`researcher` / `nursery_worker` / `inspector` / `base_coordinator` / `recall_officer` / `auditor`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/mothers` | 母本登记 |
| POST | `/api/batches` | 育苗批登记 |
| POST | `/api/batches/:id/split` | 拆批 |
| POST | `/api/batches/merge` | 合批（仅同母本） |
| GET | `/api/batches/:id` | 批次当前状态（含母本、数量、检验、位置、隔离） |
| GET | `/api/batches/:id/trace` | 向下游反查分发去向 |
| POST | `/api/inspections` | 检验记录（支持 `eventId`/`idempotencyKey`/`deviceId`/`at` 离线补录） |
| POST | `/api/inspections/correct` | 检测结果更正（追加，不改原记录） |
| POST | `/api/transports` | 跨基地调拨（矛盾调拨需 `waybill`） |
| POST | `/api/plantings` | 仿野生定植 |
| POST | `/api/recalls` | 签发定向召回（自动冻结、通知、快照） |
| POST | `/api/recalls/:id/sync-notifications` | 影响扩大后补通知（去重） |
| POST | `/api/recalls/:id/close` | 关闭召回并解除隔离 |
| GET | `/api/recalls/:id` | 召回详情（快照 + 实时影响 + 通知清单） |
| GET | `/api/streams/:id/history` | 原始事件链（只读留痕） |
| POST | `/api/offline/sync` | 离线命令批量顺序重放 |
| POST | `/api/farmers` / `/api/bases` | 农户通讯录 / 基地目录维护 |

领域约定详见 [`docs/domain.md`](docs/domain.md)。
