---
title: API 设计
domain: backend
tags: [api, backend, rest, design]
---

# 何时使用

设计对外/对内 HTTP 接口、评审新端点、或统一现有 API 风格时。

# 执行步骤

1. **资源命名**：用名词复数、层级表达从属，动作靠 HTTP 方法而非路径动词。
   - 好：`GET /users/42/orders`、`POST /orders`；差：`/getUserOrders`、`/createOrder`。
   - 非 CRUD 动作作为子资源：`POST /orders/42/cancel`。
2. **选对状态码**：200 读/改成功、201 创建（返回 `Location`）、204 无响应体、400 参数错、401 未认证、403 无权限、404 不存在、409 冲突（重复/状态不符）、422 语义校验失败、429 限流、5xx 服务端错。不要一律 200 再在 body 里塞 `code`。
3. **分页**：列表默认分页并封顶 `limit`（如默认 20、上限 100）。大数据集用游标（`cursor`/`next_token`）而非 `offset`，避免深翻页与漏读；响应带 `next_cursor` 或 `total`。
4. **过滤/排序**：过滤用查询参数 `?status=paid&created_after=...`；排序 `?sort=-created_at`（`-` 表降序，逗号分隔多字段）。字段白名单校验，拒绝任意列排序。
5. **错误结构**：统一信封，机器可读 `code` + 人类可读 `message` + 定位用 `details/field`。
   ```json
   { "error": { "code": "ORDER_ALREADY_PAID", "message": "订单已支付", "details": [{ "field": "order_id", "issue": "conflict" }] } }
   ```
6. **幂等性**：`GET/PUT/DELETE` 天然幂等；`POST` 创建类支持 `Idempotency-Key` 请求头，服务端按键缓存首次结果并去重，保证重试/网络抖动不产生重复副作用。
7. **版本化**：URL 版本 `/v1/...` 最直观；只做向后兼容的加法（新增字段/可选参数）。破坏性变更（删字段、改语义、改类型）必须升大版本，旧版给出弃用期与 `Deprecation`/`Sunset` 头。
8. **认证与限流**：Bearer Token/OAuth2 放 `Authorization` 头，绝不进 URL；令牌短期 + 刷新。按用户/密钥限流，返回 `429` 并带 `Retry-After`、`X-RateLimit-Remaining` 等头。

# 常见坑

- 路径里塞动词（`/deleteUser`），语义与方法重复且不 REST。
- 全部返回 200，靠 body 的 `success` 判断，客户端无法用标准中间件处理错误。
- `offset` 深翻页在高并发写场景下漏行/重复行。
- 破坏性变更不升版本，直接改字段类型，静默打挂线上调用方。
- 分页无上限，一次 `limit=100000` 拖垮数据库。
- 错误 `message` 泄露堆栈/SQL/内部路径。

# 检查清单

- [ ] 资源用名词复数，动作由 HTTP 方法表达
- [ ] 状态码按语义精确选择，非一律 200
- [ ] 列表强制分页且有 `limit` 上限
- [ ] 过滤/排序字段走白名单校验
- [ ] 错误信封含 `code` + `message` + 定位字段
- [ ] 创建类 `POST` 支持 `Idempotency-Key`
- [ ] 破坏性变更升大版本并给弃用期
- [ ] 令牌在请求头、按维度限流并返回 `Retry-After`
