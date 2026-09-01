# 一起拼豆吧：当前数据库 Schema

> 文档定位：当前数据库结构清单（Current Schema Reference）
>
> 当前数据库：PostgreSQL
>
> 事实来源：`server/src/db/schema-contract.ts`
>
> 设计背景：`docs/DATABASE_DESIGN.md`
>
> 维护原则：数据库结构发生变更时，应先同步代码中的 Schema Contract / migration，再同步更新本文档。本文档描述“当前代码期望的真实结构”，不是未来设计稿。

## 1. 当前数据库概览

项目当前使用一套 PostgreSQL 业务数据库，核心包含 11 张业务表：

| 表名 | 用途 |
| --- | --- |
| `pindou_users` | 用户主表 |
| `pindou_auth_sessions` | 登录会话 |
| `pindou_file_assets` | 文件/封面资产 |
| `pindou_works` | 作品摘要 |
| `pindou_work_patterns` | 作品完整图案 |
| `pindou_favorites` | 收藏关系 |
| `pindou_download_records` | 下载记录 |
| `pindou_quota_transactions` | 下载/购买等额度流水 |
| `pindou_packages` | 可购买套餐 |
| `pindou_orders` | 支付订单 |
| `pindou_ai_generation_jobs` | AI 精致生成任务与状态机 |

关系概览：

```text
pindou_users
  ├── pindou_auth_sessions
  ├── pindou_file_assets
  ├── pindou_works ─── pindou_work_patterns
  │      ├── pindou_favorites
  │      └── pindou_download_records ─── pindou_quota_transactions
  ├── pindou_quota_transactions
  ├── pindou_orders ─── pindou_packages
  └── pindou_ai_generation_jobs ─── pindou_file_assets
```

## 2. `pindou_users`

用户主表。

| 字段 | PostgreSQL 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `varchar(32)` | 否 | 用户 ID，主键 |
| `openid_hash` | `varchar(128)` | 否 | 微信 OpenID 摘要，唯一索引 |
| `openid_ciphertext` | `text` | 是 | OpenID 加密值（如启用） |
| `nickname` | `varchar(80)` | 是 | 用户昵称 |
| `avatar_url` | `text` | 是 | 用户头像 |
| `created_at` | `timestamptz` | 否 | 创建时间 |
| `updated_at` | `timestamptz` | 否 | 更新时间 |
| `deleted_at` | `timestamptz` | 是 | 软删除时间 |

主要约束/索引：

- PK：`id`
- UNIQUE：`openid_hash`

## 3. `pindou_auth_sessions`

登录会话表。

| 字段 | PostgreSQL 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `varchar(32)` | 否 | 会话 ID，主键 |
| `user_id` | `varchar(32)` | 否 | 用户 ID |
| `token_hash` | `varchar(128)` | 否 | Token 摘要 |
| `expires_at` | `timestamptz` | 否 | 过期时间 |
| `revoked_at` | `timestamptz` | 是 | 主动失效时间 |
| `created_at` | `timestamptz` | 否 | 创建时间 |
| `last_used_at` | `timestamptz` | 是 | 最近使用时间 |

主要约束/索引：

- PK：`id`
- FK：`user_id -> pindou_users.id`
- UNIQUE：`token_hash`
- INDEX：`user_id`
- INDEX：`expires_at`

## 4. `pindou_file_assets`

文件资产表，保存作品封面、AI 输入和 AI 输出。

| 字段 | PostgreSQL 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `varchar(32)` | 否 | 文件 ID，主键 |
| `user_id` | `varchar(32)` | 否 | 所有者 |
| `file_type` | `varchar(20)` | 否 | `cover` / `ai_input` / `ai_output` |
| `object_key` | `varchar(512)` | 否 | 对象存储 Key |
| `public_url` | `text` | 否 | 对外访问地址 |
| `content_type` | `varchar(100)` | 否 | MIME 类型 |
| `byte_size` | `int8` | 否 | 文件字节数 |
| `width` | `int4` | 是 | 图片宽度 |
| `height` | `int4` | 是 | 图片高度 |
| `created_at` | `timestamptz` | 否 | 创建时间 |
| `deleted_at` | `timestamptz` | 是 | 删除时间 |

主要约束/索引：

- PK：`id`
- FK：`user_id -> pindou_users.id`
- UNIQUE：`object_key`
- CHECK：`file_type` 限定为 `cover`、`ai_input`、`ai_output`
- CHECK：`byte_size > 0`
- INDEX：`(user_id, file_type, created_at)`

## 5. `pindou_works`

作品摘要表。列表页主要读取这张表，完整图案不直接存这里。

| 字段 | PostgreSQL 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `varchar(32)` | 否 | 作品 ID，主键 |
| `user_id` | `varchar(32)` | 否 | 作品所有者 |
| `title` | `varchar(120)` | 否 | 作品名称 |
| `cover_file_id` | `varchar(32)` | 否 | 封面文件 ID |
| `width` | `int2` | 否 | 图案宽度 |
| `height` | `int2` | 否 | 图案高度 |
| `bead_count` | `int4` | 否 | 非透明拼豆数量 |
| `color_count` | `int2` | 否 | 实际使用颜色数 |
| `brand` | `varchar(40)` | 否 | 色板/品牌 |
| `status` | `varchar(20)` | 否 | `draft` / `completed` |
| `created_at` | `timestamptz` | 否 | 创建时间 |
| `updated_at` | `timestamptz` | 否 | 更新时间 |
| `deleted_at` | `timestamptz` | 是 | 软删除时间 |

主要约束/索引：

- PK：`id`
- FK：`user_id -> pindou_users.id`
- FK：`cover_file_id -> pindou_file_assets.id`
- CHECK：`status in ('draft', 'completed')`
- CHECK：宽高不得超过 128
- CHECK：`bead_count >= 0`
- CHECK：`color_count >= 0`
- INDEX：`(user_id, updated_at)`
- INDEX：`(user_id, status, updated_at)`

## 6. `pindou_work_patterns`

作品完整图案表，与 `pindou_works` 一对一。

| 字段 | PostgreSQL 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `work_id` | `varchar(32)` | 否 | 作品 ID，同时为主键 |
| `schema_version` | `int2` | 否 | 当前 Schema Version = 1 |
| `width` | `int2` | 否 | 图案宽度 |
| `height` | `int2` | 否 | 图案高度 |
| `color_limit` | `int2` | 否 | 生成时颜色上限 |
| `brand` | `varchar(40)` | 否 | 色板/品牌 |
| `palette_json` | `jsonb` | 否 | 颜色表 |
| `cells_json` | `jsonb` | 否 | 单元格颜色索引数组 |
| `created_at` | `timestamptz` | 否 | 创建时间 |
| `updated_at` | `timestamptz` | 否 | 更新时间 |

主要约束：

- PK/FK：`work_id -> pindou_works.id`
- CHECK：`schema_version = 1`
- CHECK：宽高不得超过 128
- CHECK：`color_limit > 0`

`palette_json` 与 `cells_json` 的业务结构由服务端 Pattern Validator 继续校验。

## 7. `pindou_favorites`

收藏关系表。

| 字段 | PostgreSQL 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `user_id` | `varchar(32)` | 否 | 用户 ID |
| `quota_kind` | `varchar(30)` | 否 | `standard_download` / `ai_generation` |
| `work_id` | `varchar(32)` | 否 | 作品 ID |
| `created_at` | `timestamptz` | 否 | 收藏时间 |

主要约束/索引：

- 组合 PK：`(user_id, work_id)`
- FK：`user_id -> pindou_users.id`
- FK：`work_id -> pindou_works.id`
- INDEX：`(user_id, created_at)`

## 8. `pindou_download_records`

下载记录表。

| 字段 | PostgreSQL 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `varchar(32)` | 否 | 下载记录 ID |
| `user_id` | `varchar(32)` | 否 | 用户 ID |
| `work_id` | `varchar(32)` | 是 | 作品 ID；作品删除后可置空 |
| `work_title_snapshot` | `varchar(120)` | 否 | 下载时作品标题快照 |
| `file_type` | `varchar(20)` | 否 | `preview` / `chart` / `materials` / `palette` |
| `consumed_quota` | `bool` | 否 | 是否消耗额度 |
| `quota_transaction_id` | `varchar(32)` | 是 | 对应额度扣减流水 |
| `idempotency_key` | `varchar(128)` | 否 | 下载幂等键 |
| `downloaded_at` | `timestamptz` | 否 | 下载时间 |

主要约束/索引：

- PK：`id`
- FK：`user_id -> pindou_users.id`
- FK：`work_id -> pindou_works.id`，删除作品时 `SET NULL`
- FK：`quota_transaction_id -> pindou_quota_transactions.id`
- CHECK：`file_type in ('preview', 'chart', 'materials', 'palette')`
- UNIQUE：`idempotency_key`
- INDEX：`(user_id, downloaded_at)`
- INDEX：`(user_id, file_type, downloaded_at)`

## 9. `pindou_quota_transactions`

额度流水表。当前余额以流水汇总为准。

| 字段 | PostgreSQL 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `varchar(32)` | 否 | 流水 ID |
| `user_id` | `varchar(32)` | 否 | 用户 ID |
| `type` | `varchar(30)` | 否 | 流水类型 |
| `amount` | `int4` | 否 | 正数发放、负数扣减 |
| `source` | `varchar(40)` | 否 | 来源 |
| `bucket` | `varchar(20)` | 否 | `daily_free` / `purchased` / `membership` |
| `quota_date` | `date` | 是 | 每日免费额度所属自然日 |
| `order_id` | `varchar(32)` | 是 | 关联订单 |
| `download_record_id` | `varchar(32)` | 是 | 关联下载记录 |
| `idempotency_key` | `varchar(128)` | 是 | 流水幂等键 |
| `note` | `varchar(255)` | 是 | 备注 |
| `created_at` | `timestamptz` | 否 | 创建时间 |

当前允许的 `type`：

- `daily_grant`
- `download_debit`
- `usage_debit`
- `purchase_grant`
- `refund`
- `adjustment`

主要约束/索引：

- PK：`id`
- FK：`user_id -> pindou_users.id`
- FK：`order_id -> pindou_orders.id`
- FK：`download_record_id -> pindou_download_records.id`
- CHECK：`amount <> 0`
- 每日免费发放按 `(user_id, type, quota_kind, quota_date)` 唯一
- 购买发放按 `order_id` 唯一
- 下载扣减按 `download_record_id` 唯一
- AI 使用扣减按 `idempotency_key` 唯一
- INDEX：`(user_id, created_at)`

## 10. `pindou_packages`

可购买套餐表。

| 字段 | PostgreSQL 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `varchar(40)` | 否 | 套餐 ID |
| `label` | `varchar(80)` | 否 | 套餐名称 |
| `quota_amount` | `int4` | 否 | 提供额度 |
| `quota_kind` | `varchar(30)` | 否 | 套餐发放的额度类型 |
| `membership_type` | `varchar(30)` | 是 | 可选会员类型 |
| `membership_days` | `int4` | 是 | 会员有效天数 |
| `price_fen` | `int4` | 否 | 价格，单位分 |
| `currency` | `varchar(3)` | 否 | 当前为 CNY |
| `enabled` | `bool` | 否 | 是否可购买 |
| `sort_order` | `int4` | 否 | 展示排序 |
| `created_at` | `timestamptz` | 否 | 创建时间 |
| `updated_at` | `timestamptz` | 否 | 更新时间 |

主要约束：

- PK：`id`
- CHECK：`quota_amount >= 0`
- CHECK：`price_fen >= 0`
- CHECK：`membership_days > 0`（存在时）
- CHECK：币种为 CNY

## 11. `pindou_orders`

支付订单表。

| 字段 | PostgreSQL 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `varchar(32)` | 否 | 订单 ID |
| `user_id` | `varchar(32)` | 否 | 用户 ID |
| `package_id` | `varchar(40)` | 是 | 套餐 ID；套餐被删除后允许置空 |
| `package_label_snapshot` | `varchar(80)` | 否 | 下单时套餐名称快照 |
| `quota_amount_snapshot` | `int4` | 否 | 下单时额度快照 |
| `quota_kind_snapshot` | `varchar(30)` | 否 | 下单时额度类型快照 |
| `membership_type_snapshot` | `varchar(30)` | 是 | 会员类型快照 |
| `price_fen` | `int4` | 否 | 下单金额，单位分 |
| `status` | `varchar(20)` | 否 | 订单状态 |
| `wx_prepay_id` | `varchar(128)` | 是 | 微信预支付 ID |
| `wx_transaction_id` | `varchar(128)` | 是 | 微信支付交易号 |
| `paid_at` | `timestamptz` | 是 | 支付时间 |
| `created_at` | `timestamptz` | 否 | 创建时间 |
| `updated_at` | `timestamptz` | 否 | 更新时间 |

主要约束/索引：

- PK：`id`
- FK：`user_id -> pindou_users.id`
- FK：`package_id -> pindou_packages.id`，删除套餐时 `SET NULL`
- UNIQUE：`wx_transaction_id`
- CHECK：`quota_amount_snapshot >= 0`
- CHECK：`price_fen >= 0`
- `status` 的合法值由当前 Schema Contract 的 CHECK 约束维护

## 12. `pindou_ai_generation_jobs`

AI 精致生成任务表。客户端创建任务后轮询状态；只有输出图片落库成功时才写 AI 额度扣减流水。

| 字段 | PostgreSQL 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `varchar(32)` | 否 | 任务 ID |
| `user_id` | `varchar(32)` | 否 | 用户 ID |
| `input_file_id` | `varchar(32)` | 否 | `ai_input` 文件 ID |
| `output_file_id` | `varchar(32)` | 是 | 成功后的 `ai_output` 文件 ID |
| `provider` | `varchar(40)` | 否 | Provider 快照，当前为 `qwen` |
| `model` | `varchar(80)` | 否 | 模型快照 |
| `status` | `varchar(20)` | 否 | `queued` / `processing` / `succeeded` / `failed` / `canceled` |
| `prompt_version` | `varchar(20)` | 否 | 服务端提示词版本 |
| `style` | `varchar(20)` | 否 | `natural` / `cartoon` / `minimal` |
| `detail_level` | `varchar(20)` | 否 | `low` / `medium` / `high` |
| `background_mode` | `varchar(20)` | 否 | `keep` / `simplify` / `remove` |
| `provider_request_id` | `varchar(128)` | 是 | Provider 异步任务 ID |
| `idempotency_key` | `varchar(128)` | 否 | 同一用户创建任务的幂等键 |
| `error_code` | `varchar(80)` | 是 | 稳定失败代码 |
| `created_at` / `updated_at` | `timestamptz` | 否 | 创建/更新时间 |
| `started_at` / `completed_at` | `timestamptz` | 是 | 处理/完成时间 |
| `expires_at` | `timestamptz` | 否 | 任务查询截止时间 |

幂等唯一索引为 `(user_id, idempotency_key)`；活跃状态索引用于额度预留和超时巡检。

## 13. Schema 的事实来源与验证方式

### 13.1 事实来源优先级

以后遇到文档与代码不一致，按以下顺序判断：

1. 实际 PostgreSQL 数据库结构
2. `server/src/db/schema-contract.ts`
3. migration / 建表 SQL（如后续引入）
4. `docs/DATABASE_SCHEMA.md`（本文档）
5. `docs/DATABASE_DESIGN.md`（设计背景/历史决策）

`DATABASE_DESIGN.md` 不应该再被当成唯一的“当前数据库字段清单”。

### 12.2 仓库已有 Schema 检查能力

`server/src/db/` 当前已经提供：

- `schema-contract.ts`：定义期望表、字段、类型、可空性、长度、索引和约束
- `schema-inspector.ts`：读取并检查实际数据库 Schema
- `inspect-cli.ts`：命令行入口
- `database-runtime.ts` / `pool.ts`：数据库运行与连接能力

后端 `package.json` 已提供：

```bash
npm run db:inspect
```

用于检查当前 PostgreSQL 数据库与仓库 Schema Contract 是否一致。

## 13. 后续维护规则

发生以下任意变化时必须更新本文档：

- 新增或删除表
- 新增、删除或重命名字段
- 字段类型变化
- NULL/NOT NULL 变化
- 主键/外键变化
- CHECK / UNIQUE 约束变化
- 索引发生业务性变化

推荐流程：

```text
数据库/业务需求变化
  -> 修改 Schema / migration
  -> 更新 schema-contract.ts
  -> npm run db:inspect
  -> 更新 DATABASE_SCHEMA.md
  -> 更新 CHANGELOG.md
```

这样仓库同时保留：

- `DATABASE_DESIGN.md`：为什么这样设计
- `DATABASE_SCHEMA.md`：现在实际有哪些表和字段
- `schema-contract.ts`：代码可以自动校验的数据库契约
