# 石斛种源追溯网

为曲茎石斛产业的母本、育苗批、检验、转运、定植建立**只追加事件链**，支持批次拆分/合并血缘、离线采集补录、检测结果更正、跨基地调拨、定向召回与通知去重。研究数据与农户联系方式**分文件分区、按角色授权**。

零第三方依赖（仅 Node.js ≥ 20 内置模块），数据默认落在 `./data/`（已在 `.gitignore` 中忽略）。

## 运行

```bash
npm test          # 13 个测试：领域不变量 + HTTP 端到端 + 持久化恢复
npm start         # 默认 http://0.0.0.0:3000，可用 PORT / DATA_DIR 覆盖
```

## 快速试一遍季末演练

```bash
# 身份通过请求头传递（演示用，生产应替换为签名/网关注入）
H=(-H 'content-type: application/json' -H 'x-user-id: c1' -H 'x-user-role: coordinator')

# 母本 → 育苗批 3000 株 → 拆往三处林地各 900（余 300 在库）
curl -s "${H[@]}" -X POST localhost:3000/v1/events/batch -d @- <<'JSON'
{ "events": [
  {"type":"mother_registered","batchId":"M-1","label":"TAG-M1","baseId":"BASE-A","quantity":20,"at":"2026-01-01T00:00:00Z"},
  {"type":"batch_germinated","batchId":"S-1","label":"TAG-S1","motherBatchId":"M-1","baseId":"BASE-A","quantity":3000,"at":"2026-03-01T00:00:00Z"},
  {"type":"batch_split","parentBatchId":"S-1","children":[
    {"batchId":"S-1A","label":"TAG-A","quantity":900},
    {"batchId":"S-1B","label":"TAG-B","quantity":900},
    {"batchId":"S-1C","label":"TAG-C","quantity":900}
  ],"at":"2026-04-05T00:00:00Z"},
  {"type":"planting_recorded","batchId":"S-1A","siteId":"WOOD-A","farmerId":"F-1","quantity":900,"at":"2026-04-06T00:00:00Z"},
  {"type":"planting_recorded","batchId":"S-1B","siteId":"WOOD-B","farmerId":"F-2","quantity":900,"at":"2026-04-07T00:00:00Z"},
  {"type":"planting_recorded","batchId":"S-1C","siteId":"WOOD-C","farmerId":"F-1","quantity":900,"at":"2026-04-08T00:00:00Z"}
]}
JSON

# 检测员离线补录：4 月 3 日的不合格结果，晚于定植才同步
curl -s "${H[@]}" -H 'x-user-role: inspector' -H 'x-user-id: i1' -X POST localhost:3000/v1/events \
  -d '{"type":"inspection_recorded","batchId":"S-1","verdict":"unqualified","at":"2026-04-03T00:00:00Z"}'

# 影响范围（三处林地、2700 株已植、300 株剩余可用、F-1 只出现一次）
curl -s "${H[@]}" localhost:3000/v1/impacts/S-1

# 发布召回 + 一键隔离剩余 300 株
curl -s "${H[@]}" -X POST localhost:3000/v1/recalls \
  -d '{"recallId":"R-1","triggerBatchId":"S-1","reason":"镰刀菌阳性补录","quarantine":true}'

# 逐点确认
curl -s "${H[@]}" -X POST localhost:3000/v1/recalls/R-1/acknowledge \
  -d '{"targetType":"site","targetId":"WOOD-A"}'
curl -s "${H[@]}" localhost:3000/v1/recalls/R-1
```

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/events` | 追加单个事件（支持 `eventId` 幂等、`at` 补录） |
| POST | `/v1/events/batch` | 离线批量同步：整组暂存一次校验，乱序可生效，失败整体回滚 |
| GET | `/v1/events` | 事件链（`fromSeq` 增量同步游标、`limit`） |
| GET | `/v1/batches` / `/v1/batches/:id` | 批次与当前存量（跨基地操作员只见限量字段） |
| GET | `/v1/batches/:id/trace` | 成活率反查：母本、育苗条件、事件链、分发去向 |
| GET | `/v1/batches/:id/inspections` | 当前有效检验结论 + 完整更正历史 |
| GET | `/v1/impacts/:batchId` | 影响范围：批次闭包、定植点、去重通知对象、剩余可用量 |
| POST | `/v1/recalls` | 发布定向召回（`quarantine:true` 同步隔离在库），重复发布幂等 |
| POST | `/v1/recalls/:id/expand` | 血缘扩容后补发通知（仍去重） |
| POST | `/v1/recalls/:id/acknowledge` | 定植点/在库批次执行确认（幂等） |
| GET | `/v1/recalls/:id` | 召回状态：已通知、已确认、待执行清单 |
| POST/GET | `/v1/contacts` | 农户联系方式（分权；无权角色只见脱敏编号） |
| POST/GET | `/v1/mothers/:id/research-notes` | 母本研究数据（仅研究人员/联合体） |

## 代码结构

```
src/domain/ledger.mjs    事件目录、追加校验、(at,seq) 投影重建、拆合批血缘
src/domain/trace.mjs     反查、影响范围、召回去重通知/扩容/隔离/确认
src/domain/directory.mjs 研究数据与联系方式的角色分权分区
src/store/file-store.mjs JSONL 事件日志 + JSON 分区文件（原子写）
src/http/app-server.mjs  路由、鉴权头、错误码映射
src/app.mjs              编排：账本 + 分区 + 权限矩阵 + 持久化
```

领域约定与不变量见 [`docs/domain.md`](./docs/domain.md)。
