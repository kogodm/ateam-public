---
title: 数据库模式设计
domain: backend
tags: [database, schema, sql, design]
---

# 何时使用

新建表结构、评审数据模型、加索引或做迁移，尤其是关系型数据库（PostgreSQL/MySQL）场景。

# 执行步骤

1. **先规范化再按需反规范化**：默认到 3NF，消除更新异常与冗余。仅当读放大成为实测瓶颈、且能接受一致性维护成本时，才反规范化（冗余字段、物化视图、计数缓存），并写明由谁在何时同步。
2. **主键**：优先无业务含义的代理键。自增 `BIGINT` 顺序写友好但可枚举；分布式/对外暴露用 `UUIDv7`（时间有序，避免 v4 随机导致 B-Tree 页分裂）。绝不用手机号/邮箱等业务字段做主键。
3. **外键与约束**：显式声明 `FOREIGN KEY` 并选好 `ON DELETE`（`RESTRICT`/`CASCADE`/`SET NULL`）。约束（`NOT NULL`、`UNIQUE`、`CHECK`、外键）优先在数据库层，而非只靠应用校验——应用有多个、会绕过，数据库是最后防线。
4. **索引策略**：为高频 `WHERE`/`JOIN`/`ORDER BY` 列建索引；复合索引遵循最左前缀，把等值列放前、范围列放后。用覆盖索引省回表。警惕过度索引：每个索引都拖慢写入并占空间。上线前用 `EXPLAIN` 验证走了索引。
5. **数据类型**：够用就好——金额用 `DECIMAL`（禁 `FLOAT`，浮点丢精度）、时间统一 `TIMESTAMPTZ` 存 UTC、枚举用 `ENUM` 或小 `SMALLINT` + 约束、变长文本 `VARCHAR(n)`/`TEXT`。窄类型省内存、提缓存命中。
6. **软删除与审计**：需要可恢复/审计时加 `deleted_at`（NULL 为有效行），配合部分唯一索引 `WHERE deleted_at IS NULL`。统一审计字段 `created_at`/`updated_at`/`created_by`，`updated_at` 用触发器或 ORM 钩子维护。
7. **零停机迁移**：拆成向后兼容的小步。加列用可空或带默认（PG 11+ 加默认不再全表重写）；改列类型/加约束分「先加不校验 → 补数据 → 再 `VALIDATE`」；建索引用 `CREATE INDEX CONCURRENTLY`。删列/改名走「扩展-收缩」：先双写兼容，等旧代码下线再删。
8. **大表演进**：预估增长，提前规划分区（按时间/范围）或归档策略，别等到亿级行再动刀。

# 常见坑

- 金额用 `FLOAT`/`DOUBLE`，累加后对不上账。
- 唯一约束没排除软删除行，删了又重建同值报冲突。
- 生产直接 `ALTER TABLE ADD COLUMN ... DEFAULT`（老版本）或加 `NOT NULL` 全表锁，长事务卡死。
- 复合索引列序与查询不匹配，索引形同虚设。
- 只在应用层校验，另一个服务/脚本直连写脏数据。
- `CREATE INDEX` 不加 `CONCURRENTLY`，建索引期间写阻塞。

# 检查清单

- [ ] 默认 3NF，反规范化处标注同步责任
- [ ] 主键为代理键，非业务字段
- [ ] 外键、`NOT NULL`、`UNIQUE`、`CHECK` 落在数据库层
- [ ] 索引匹配真实查询，`EXPLAIN` 验证过
- [ ] 金额用 `DECIMAL`，时间用 `TIMESTAMPTZ` 存 UTC
- [ ] 软删除配部分唯一索引，审计字段齐全
- [ ] 迁移向后兼容、分步、索引 `CONCURRENTLY`
- [ ] 删列/改名走扩展-收缩双写过渡
