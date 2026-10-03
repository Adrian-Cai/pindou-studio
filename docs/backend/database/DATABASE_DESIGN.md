# 拼豆工作室数据库设计

> 文档状态：MVP 设计稿
>
> 版本：v1.0
>
> 目标：为 `docs/backend/API_SPEC.md` 提供可审计、可恢复、可追溯的数据模型

> 物理表命名规则：所有表名必须以 `pindou_` 开头；本文中的逻辑实体名可以省略前缀，但建库时必须使用带前缀的物理表名

## 1. 设计决策

### 1.1 图案数据采用“颜色表 + 索引数组”

当前客户端结构是每格一个对象：

```json
{ "color": "#f4d7bf", "colorCode": "C01" }
```

服务端不按这个结构保存持久化图案只保存一次颜色定义，以及每个格子的颜色索引：

```json
{
  "schemaVersion": 1,
  "generationMode": "standard",
  "width": 64,
  "height": 64,
  "settings": { "colorLimit": 32, "brand": "MARD" },
  "palette": [
    { "code": "C01", "color": "#f4d7bf" },
    { "code": "C02", "color": "#000000" }
  ],
  "cells": [0, 0, -1, 1]
}
```

其中 `-1` 表示透明格，其他整数指向 `palette` 的下标数组按行优先排列，长度必须等于 `width * height`

### 1.2 第一版将压缩图案存为数据库 JSON 文档

最大尺寸为 `128 × 128 = 16384` 格改为整数数组后，图案是一个单独的 JSON 文档，适合放在独立的 `pindou_work_patterns` 表中：

- `pindou_works` 保持轻量，只负责列表、归属、封面和统计字段
- `pindou_work_patterns` 一对一保存完整图案，历史恢复只需一次读取
- 数据库使用 JSON/JSONB 类型时，不把每个格子拆成行
- 如果实际数据库的单行限制或备份成本不合适，可以把同一份 JSON 文档迁移到对象存储；API 结构不变，迁移时只需替换 `pindou_work_patterns` 的存取层

第一版不为 `cells` 单独建立对象存储 URL，也不把 16384 个格子展开成关系表

### 1.3 额度以流水为准，用户表不保存唯一余额

`pindou_users` 不保存 `purchasedQuota` 作为唯一事实所有免费发放、购买、下载扣减、退款和人工调整都写入 `pindou_quota_transactions`

当前余额由流水汇总得到；为了性能可以增加缓存，但缓存只能是可重建的派生数据，不能替代流水

### 1.4 图片只存对象存储元数据

数据库不保存图片二进制第一版只保存客户端导出的作品封面/预览图，不永久保存原始上传图，不保存服务端成品图或施工图

## 2. 实体关系

```text
pindou_users
  ├── pindou_auth_sessions
  ├── pindou_works ─── pindou_work_patterns
  │      ├── pindou_favorites
  │      └── pindou_download_records ─── pindou_quota_transactions
  ├── pindou_file_assets
  ├── pindou_quota_transactions
  ├── pindou_orders ─── pindou_packages
  │      ├── pindou_payment_attempts ─── pindou_payment_events
  │      └── pindou_payment_events
  └── pindou_content_security_checks
```

约束：

- 所有用户数据通过 `user_id` 归属
- `pindou_work_patterns.work_id` 与 `pindou_works.id` 一对一
- `pindou_favorites` 的 `(user_id, work_id)` 唯一
- 下载扣减与下载记录必须在同一数据库事务中完成
- 支付回调发放额度必须以 `order_id` 做幂等约束

## 3. 表设计

以下字段使用逻辑名称；具体 SQL 类型根据选用的数据库映射时间字段建议使用带时区的时间类型或统一存 UTC

### 3.0 物理表用途总览

| 物理表 | 这是什么表 | 主要用途 |
| --- | --- | --- |
| `pindou_users` | 用户主表 | 保存微信用户与本系统用户的对应关系、昵称和头像 |
| `pindou_auth_sessions` | 登录会话表 | 保存登录 token 的摘要、有效期和失效状态 |
| `pindou_file_assets` | 文件资产表 | 保存封面图片在对象存储中的地址和元数据 |
| `pindou_works` | 作品主表 | 保存作品归属、标题、封面、尺寸和统计摘要 |
| `pindou_work_patterns` | 作品图案表 | 保存作品完整的颜色表与网格索引数据 |
| `pindou_text_image_works` | 文生图作品表 | 保存文生图原图与提示词，不包含拼豆网格 |
| `pindou_favorites` | 收藏关系表 | 记录哪个用户收藏了哪个作品 |
| `pindou_download_records` | 下载记录表 | 记录用户导出了哪个作品、哪种类型和是否消耗额度 |
| `pindou_quota_transactions` | 额度流水表 | 记录免费额度、购买额度、下载扣减、退款和人工调整 |
| `pindou_packages` | 充值套餐表 | 保存可购买套餐的名称、价格、额度和会员配置 |
| `pindou_orders` | 支付订单表 | 保存微信支付订单、金额、状态和支付回调信息 |
| `pindou_payment_attempts` | 支付尝试表 | 保留每个永久唯一商户单号、微信交易号和查询状态 |
| `pindou_payment_events` | 支付事件表 | 去重并追踪已验签推送的处理状态，不保存原始报文 |
| `pindou_content_security_checks` | 内容安全审核表 | 保存微信文本/图片审核任务、异步回调状态和临时媒体引用 |

维护要求：建表 SQL 必须为每张表和每个字段写数据库注释注释至少说明“这是什么”和“在什么业务场景使用”，不能只重复字段名

#### `pindou_content_security_checks`

用于记录作品名称和上传图片的微信内容安全检测表内不保存明文 OpenID 或原始文本；图片对象只在微信异步审核完成或记录过期前临时保留

### 3.1 `pindou_users`

用户主表：一个微信用户对应一条本系统用户记录用于登录后识别数据归属，不保存可变额度余额

| 字段 | 类型建议 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | varchar(32) | PK | `usr_` 前缀的服务端 ID |
| `openid_hash` | varchar(128) | UNIQUE, NULL | 当前有效账号的微信 `openid` 不可逆检索摘要；账号注销后清空，使同一微信可重新注册新账号 |
| `openid_ciphertext` | text | NULL | 如业务需要，保存加密后的原值；密钥不入库 |
| `nickname` | varchar(80) | NULL | 初始允许为空 |
| `avatar_url` | text | NULL | 初始允许为空 |
| `created_at` | timestamp | NOT NULL | 服务端创建时间 |
| `updated_at` | timestamp | NOT NULL | 服务端更新时间 |
| `deleted_at` | timestamp | NULL | 账号和作品软删除时间；注销接口保留审计与财务记录 |

说明：`session_key` 不返回前端如后续需要调用微信需要 session key 的能力，应使用加密字段或独立密钥存储，不以明文保存

索引：`openid_hash` 唯一索引，`created_at` 普通索引可选

### 3.2 `pindou_auth_sessions`

登录会话表：保存本系统 token 会话推荐使用随机 opaque token，数据库只保存摘要

| 字段 | 类型建议 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | varchar(32) | PK | `ses_` 前缀 |
| `user_id` | varchar(32) | FK, NOT NULL | 关联 `pindou_users.id` |
| `token_hash` | varchar(128) | UNIQUE, NOT NULL | token 摘要 |
| `expires_at` | timestamp | NOT NULL | 过期时间 |
| `revoked_at` | timestamp | NULL | 主动失效时间 |
| `created_at` | timestamp | NOT NULL | 创建时间 |
| `last_used_at` | timestamp | NULL | 最近使用时间，可选 |

索引：`user_id`、`expires_at`

### 3.3 `pindou_file_assets`

文件资产表：保存对象存储文件的元数据第一版只允许 `cover`，用于作品封面/预览图

| 字段 | 类型建议 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | varchar(32) | PK | `file_` 前缀 |
| `user_id` | varchar(32) | FK, NOT NULL | 文件所有者 |
| `file_type` | varchar(20) | NOT NULL | 第一版：`cover` |
| `object_key` | varchar(512) | UNIQUE, NOT NULL | 对象存储 key，不直接暴露内部路径 |
| `public_url` | text | NOT NULL | 对外读取地址或 CDN 地址 |
| `content_type` | varchar(100) | NOT NULL | 例如 `image/png` |
| `byte_size` | bigint | NOT NULL | 文件大小 |
| `width` | integer | NULL | 图片宽度，可选 |
| `height` | integer | NULL | 图片高度，可选 |
| `created_at` | timestamp | NOT NULL | 上传完成时间 |
| `deleted_at` | timestamp | NULL | 异步清理用 |

规则：

- 只有上传成功并完成真实格式校验后，才写入可绑定的 `pindou_file_assets`
- `pindou_works.cover_file_id` 只能引用当前用户拥有的 `cover` 文件
- 原始图片不作为第一版 `file_type`；客户端应上传作品封面/预览图

索引：`(user_id, file_type, created_at)`

### 3.4 `pindou_works`

作品主表：保存作品摘要与归属完整图案放在 `pindou_work_patterns`，列表接口主要读取本表

| 字段 | 类型建议 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | varchar(32) | PK | `work_` 前缀 |
| `user_id` | varchar(32) | FK, NOT NULL | 作品所有者 |
| `title` | varchar(120) | NOT NULL | 默认“未命名作品” |
| `cover_file_id` | varchar(32) | FK, NOT NULL | 关联 `pindou_file_assets.id` |
| `width` | smallint | NOT NULL | 从 pattern 校验后写入 |
| `height` | smallint | NOT NULL | 从 pattern 校验后写入 |
| `bead_count` | integer | NOT NULL | 非透明格数量，服务端重算 |
| `color_count` | smallint | NOT NULL | 实际使用颜色数量，服务端重算 |
| `brand` | varchar(40) | NOT NULL | 图案设置中的品牌 |
| `generation_mode` | varchar(20) | NOT NULL | `standard` 或 `ai`；历史数据迁移默认 `standard` |
| `creation_source` | varchar(20) | NOT NULL | `image` 或 `text`；历史数据迁移默认 `image` |
| `source_prompt` | text | NULL | 文本创作时保存的原始描述，1–500 字；图片创作必须为空 |
| `status` | varchar(20) | NOT NULL | `draft` 或 `completed` |
| `created_at` | timestamp | NOT NULL | 服务端创建时间 |
| `updated_at` | timestamp | NOT NULL | 服务端更新时间 |
| `deleted_at` | timestamp | NULL | 推荐软删除，第一版 API 表现为删除成功 |

不保存：前端草稿 id、前端时间戳、`sourceImagePath`、`fileUrl`、对象数组形式的 `cells`

`creation_source` 表示输入来源，与 `generation_mode`（拼豆转换模式）分开。文字创作提示词随云端作品保留，作品删除后随作品记录停用。

### 3.4.1 `pindou_text_image_generation_jobs`

文生图任务表保存用户提示词、服务端模型快照、任务状态、短期输出文件引用及恢复时间。提示词最多 500 字；任务成功时复用 AI 输出文件资产并以幂等流水扣除一次 `ai_generation` 额度，失败不扣。未消费任务及输出默认 24 小时后清理。

索引：`(user_id, updated_at DESC)`、`(user_id, status, updated_at DESC)`；标题搜索按数据库能力增加全文或前缀索引

### 3.4.2 `pindou_text_image_works`

成功的文生图原图通过独立记录作为作品长期保存，不创建虚假的拼豆图案。`source_job_id` 唯一，保证一次任务最多关联一条作品；作品删除后保留软删除记录以阻止同一任务重新生成副本。原图文件作为 `pindou_file_assets` 的 `cover` 类型资产保存，删除作品时同步停用资产并清理对象文件。

| 字段 | 类型建议 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | varchar(32) | PK | 文生图作品编号 |
| `user_id` | varchar(32) | FK, NOT NULL | 作品所有者 |
| `source_job_id` | varchar(32) | NOT NULL, UNIQUE | 来源文生图任务；不设任务外键，以便短期任务过期清理后作品继续存在 |
| `image_file_id` | varchar(32) | FK, NOT NULL | 持久化原图的文件资产 |
| `prompt` | varchar(500) | NOT NULL | 用户提交的画面描述 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | 创建与修改时间 |
| `deleted_at` | timestamptz | NULL | 软删除时间 |

列表索引：`(user_id, created_at DESC) WHERE deleted_at IS NULL`。迁移：`server/sql/023_text_image_works.sql`。

### 3.5 `pindou_work_patterns`

作品图案表：一份作品一份完整图案，用于历史作品详情和重新恢复编辑器网格

| 字段 | 类型建议 | 约束 | 说明 |
| --- | --- | --- | --- |
| `work_id` | varchar(32) | PK, FK | 关联 `pindou_works.id` |
| `schema_version` | smallint | NOT NULL | 当前为 `1` |
| `width` | smallint | NOT NULL | 必须与 `pindou_works.width` 一致 |
| `height` | smallint | NOT NULL | 必须与 `pindou_works.height` 一致 |
| `color_limit` | smallint | NOT NULL | 原始设置值 |
| `brand` | varchar(40) | NOT NULL | 原始设置值 |
| `palette_json` | json/jsonb | NOT NULL | `[{code,color}]` |
| `cells_json` | json/jsonb | NOT NULL | 一维整数数组 |
| `created_at` | timestamp | NOT NULL | 创建时间 |
| `updated_at` | timestamp | NOT NULL | 更新时间 |

完整逻辑结构：

```json
{
  "schemaVersion": 1,
  "generationMode": "standard",
  "width": 64,
  "height": 64,
  "settings": { "colorLimit": 32, "brand": "MARD" },
  "palette": [{ "code": "C01", "color": "#f4d7bf" }],
  "cells": [0, -1, 0]
}
```

数据库落盘时可将 `settings` 拆成列、将 `palette` 和 `cells` 分别放入 JSON 字段；API 层仍组装成上面的稳定结构

校验：

- `width * height` 不得超过产品上限 `128 * 128`
- `cells_json` 长度必须等于 `width * height`
- 每个非 `-1` 值必须是有效 palette 下标
- `palette_json` 的颜色必须是合法 6 位 hex；`code` 不得为空且在同一图案内唯一
- `pindou_works.bead_count` 等统计字段必须由同一份图案计算，禁止客户端绕过校验
- `generationMode` 必须与作品摘要的 `generation_mode` 一致；标准模式不得调用 AI 额度或 AI 服务

### 3.6 `pindou_favorites`

收藏关系表：记录当前用户对作品的收藏关系第一版只允许收藏自己的云端作品

| 字段 | 类型建议 | 约束 | 说明 |
| --- | --- | --- | --- |
| `user_id` | varchar(32) | PK 组合, FK | 当前用户 |
| `work_id` | varchar(32) | PK 组合, FK | 被收藏作品 |
| `created_at` | timestamptz | NOT NULL | 首次建立收藏关系的时间，永久不变 |
| `favorited_at` | timestamptz | NOT NULL | 最近一次进入有效收藏状态的时间 |
| `deleted_at` | timestamptz | NULL | 取消收藏时间；`NULL` 表示当前有效 |

主键/唯一约束：`(user_id, work_id)`

第一版不支持收藏他人的非公开作品；作品分享能力后续另行建模

索引：保留 `(user_id, created_at DESC)`，新增 `(user_id, favorited_at DESC) WHERE deleted_at IS NULL`

收藏关系采用软删除：取消收藏只写 `deleted_at`，重新收藏复用原记录、清空 `deleted_at` 并刷新 `favorited_at`。所有当前收藏状态、列表和统计必须过滤 `deleted_at IS NULL`；收藏操作不得修改作品的 `updated_at`。

### 3.7 `pindou_download_records`

下载记录表：记录客户端实际完成的导出，不保存服务端文件 URL；它是用户下载历史和额度扣减的业务记录

| 字段 | 类型建议 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | varchar(32) | PK | `dl_` 前缀 |
| `user_id` | varchar(32) | FK, NOT NULL | 下载用户 |
| `work_id` | varchar(32) | FK, NULL | 作品删除后可置空 |
| `work_title_snapshot` | varchar(120) | NOT NULL | 保留历史显示名称 |
| `file_type` | varchar(20) | NOT NULL | `preview`、`chart`、`materials`、`palette` |
| `consumed_quota` | boolean | NOT NULL | 本次是否扣额度 |
| `quota_transaction_id` | varchar(32) | FK, NULL | 关联扣减流水 |
| `idempotency_key` | varchar(128) | UNIQUE, NOT NULL | 一次导出动作的幂等键 |
| `downloaded_at` | timestamp | NOT NULL | 服务端记录时间 |

规则：

- `consumed_quota = true` 时必须有对应的负数额度流水
- `consumed_quota = false` 只允许未来的赠送、会员或退款等明确业务，不由客户端自行设置
- 当前 MVP 的 `POST /api/downloads` 固定按一次成功导出扣 1 次，因此客户端不提交 `consumedQuota`
- 不保存 `file_url`；历史下载记录只能展示记录，不能通过服务端重新下载

索引：`(user_id, downloaded_at DESC)`、`(user_id, file_type, downloaded_at DESC)`

### 3.8 `pindou_quota_transactions`

额度流水表：保存额度变化的每一笔原因和数量，是额度追溯的唯一事实来源

| 字段 | 类型建议 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | varchar(32) | PK | `qt_` 前缀 |
| `user_id` | varchar(32) | FK, NOT NULL | 用户 |
| `type` | varchar(30) | NOT NULL | `daily_grant`、`download_debit`、`purchase_grant`、`refund`、`adjustment` |
| `amount` | integer | NOT NULL | 正数增加，负数消耗 |
| `source` | varchar(40) | NOT NULL | `daily_free`、`download`、`payment`、`support` 等 |
| `bucket` | varchar(20) | NOT NULL | `daily_free`、`purchased`、`membership` |
| `quota_date` | date | NULL | 免费额度对应的上海时区自然日 |
| `order_id` | varchar(32) | FK, NULL | 支付发放时关联订单 |
| `download_record_id` | varchar(32) | FK, NULL | 下载扣减时关联记录 |
| `idempotency_key` | varchar(128) | NULL | 支付或扣减幂等键 |
| `note` | varchar(255) | NULL | 人工调整说明 |
| `created_at` | timestamp | NOT NULL | 服务端记录时间 |

示例流水：

| type | amount | source | bucket | 说明 |
| --- | ---: | --- | --- | --- |
| `daily_grant` | `+3` | `daily_free` | `daily_free` | 每日免费额度 |
| `download_debit` | `-1` | `download` | `daily_free` | 优先消耗免费额度 |
| `purchase_grant` | `+10` | `payment` | `purchased` | 支付购买 10 次 |
| `download_debit` | `-1` | `download` | `purchased` | 免费额度用完后的下载 |

约束：

- `(user_id, type, quota_date)` 对 `daily_grant` 做唯一约束，避免同一天重复发放免费次数
- `purchase_grant` 必须关联已支付订单，且同一个订单只能成功发放一次；退款或人工调整流水可以关联同一订单
- `download_debit` 必须关联一个下载记录
- 不允许删除或覆盖已生效流水；修正使用反向 `refund` 或 `adjustment` 新增流水

余额计算：

```text
今日免费剩余 = 今日 daily_grant + 今日 daily_free bucket 流水之和
购买额度剩余 = purchased bucket 的所有流水之和
总剩余 = max(0, 今日免费剩余) + max(0, 购买额度剩余)
```

实际实现可以缓存汇总，但必须能够从流水重建 `usedToday`、`purchased` 和 `remaining`

### 3.9 `pindou_packages`

充值套餐表：保存服务端可售套餐配置即使套餐来自配置文件，支付订单也必须保存下单时的套餐快照

| 字段 | 类型建议 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | varchar(40) | PK | 例如 `starter` |
| `label` | varchar(80) | NOT NULL | 展示名称 |
| `quota_amount` | integer | NOT NULL | 购买次数；会员可为 0 |
| `membership_type` | varchar(30) | NULL | 例如 `monthly_unlimited` |
| `membership_days` | integer | NULL | 会员有效天数 |
| `price_fen` | integer | NOT NULL | 人民币分，不能使用前端字符串价格 |
| `currency` | varchar(3) | NOT NULL | 当前为 `CNY` |
| `enabled` | boolean | NOT NULL | 是否可购买 |
| `sort_order` | integer | NOT NULL | 展示顺序 |
| `created_at` | timestamp | NOT NULL | 创建时间 |
| `updated_at` | timestamp | NOT NULL | 更新时间 |

### 3.10 `pindou_orders`

支付订单表：保存微信支付订单、套餐快照、金额和支付状态，用于支付回调验签、对账和额度发放

| 字段 | 类型建议 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | varchar(32) | PK | `order_` 前缀 |
| `user_id` | varchar(32) | FK, NOT NULL | 下单用户 |
| `package_id` | varchar(40) | NULL | 原套餐 id |
| `package_label_snapshot` | varchar(80) | NOT NULL | 下单时名称 |
| `quota_amount_snapshot` | integer | NOT NULL | 下单时购买次数 |
| `membership_type_snapshot` | varchar(30) | NULL | 下单时会员类型 |
| `price_fen` | integer | NOT NULL | 下单时金额 |
| `status` | varchar(20) | NOT NULL | `pending`、`paid`、`failed`、`closed`、`refunded` |
| `wx_prepay_id` | varchar(128) | NULL | 微信预支付 id |
| `wx_transaction_id` | varchar(128) | UNIQUE, NULL | 微信支付交易号 |
| `virtual_out_trade_no` | varchar(32) | NULL | 当前虚拟支付单号；历史支付尝试以 `pindou_payment_attempts` 为准 |
| `idempotency_key` | varchar(128) | NULL | 用户订单创建幂等键 |
| `expires_at` | timestamptz | NULL | 服务端计算的支付有效期截止时间 |
| `closed_at` | timestamptz | NULL | 确认关闭时间 |
| `paid_at` | timestamp | NULL | 支付成功时间 |
| `created_at` | timestamp | NOT NULL | 创建时间 |
| `updated_at` | timestamp | NOT NULL | 更新时间 |

约束：

- 订单金额以 `price_fen` 为准，客户端不得提交或覆盖
- 回调确认的金额、商户、订单号必须与订单快照一致
- `paid` 订单只能产生一次 `purchase_grant` 流水
- 同一用户的订单幂等键唯一；最多保留 5 个未完成订单，`UNKNOWN` 仍占用名额
- 订单过期后，微信确认某次尝试未支付或已关闭时关闭该尝试；所有尝试都关闭后，关闭本地订单

### 3.11 `pindou_payment_attempts`

每次虚拟支付尝试单独保存；`out_trade_no` 永不复用。因虚拟支付单号不能安全复用，只有微信确认前一次已关闭后才允许为同一业务订单签发新尝试。

| 字段 | 类型建议 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | varchar(32) | PK | 支付尝试 ID |
| `order_id` | varchar(32) | FK, NOT NULL | 业务订单 |
| `user_id` | varchar(32) | FK, NOT NULL | 下单用户 |
| `out_trade_no` | varchar(32) | UNIQUE, NOT NULL | 永久唯一的微信虚拟支付商户单号 |
| `status` | varchar(16) | CHECK, NOT NULL | `ISSUED`、`SUCCEEDED`、`CLOSED`、`UNKNOWN` |
| `wechat_transaction_id` | varchar(128) | UNIQUE, NULL | 微信交易号 |
| `amount_fen` | integer | NOT NULL | 支付尝试金额，必须大于 0 |
| `currency` | varchar(3) | NOT NULL | 当前仅允许 `CNY` |
| `created_at` | timestamptz | NOT NULL | 创建时间 |
| `issued_at` | timestamptz | NULL | 签发时间 |
| `paid_at` | timestamptz | NULL | 支付成功时间 |
| `closed_at` | timestamptz | NULL | 微信确认关闭时间 |
| `last_query_at` | timestamptz | NULL | 最近一次查单时间 |
| `query_count` | integer | NOT NULL | 查单次数 |
| `failure_reason` | varchar(255) | NULL | 最近一次异常摘要，不保存原始报文 |

### 3.12 `pindou_payment_events`

记录已验签支付推送的去重指纹和处理结果，不存储原始请求报文。

| 字段 | 类型建议 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | varchar(32) | PK | 支付事件 ID |
| `provider` | varchar(32) | NOT NULL | 事件来源 |
| `event_type` | varchar(80) | NOT NULL | 支付或退款事件类型 |
| `event_fingerprint` | varchar(64) | UNIQUE(provider), NOT NULL | 同一来源的事件去重指纹 |
| `order_id` | varchar(32) | FK, NULL | 关联业务订单 |
| `attempt_id` | varchar(32) | FK, NULL | 关联支付尝试 |
| `status` | varchar(24) | CHECK, NOT NULL | `RECEIVED`、`PROCESSED`、`QUERY_FAILED`、`DATA_MISMATCH`、`PROCESS_FAILED` |
| `failure_reason` | varchar(255) | NULL | 处理失败摘要 |
| `created_at` | timestamptz | NOT NULL | 接收时间 |
| `processed_at` | timestamptz | NULL | 完成处理时间 |

## 4. 事务与一致性

### 4.1 保存作品

```text
开始事务
  → 校验当前用户拥有 cover_file_id
  → 校验 PersistedPattern
  → 计算 bead_count / color_count
  → 写 pindou_works
  → 写 pindou_work_patterns
提交事务
```

如果任一步失败，不产生只有摘要没有图案，或只有图案没有摘要的半成品记录

### 4.2 下载扣额度

```text
开始事务
  → 检查 Idempotency-Key
  → 校验 work.user_id = currentUser.id
  → 汇总可用额度
  → 不足则回滚并返回 402
  → 写 pindou_download_records
  → 写 pindou_quota_transactions(amount = -1)
提交事务
```

服务端可在事务中加用户额度账户锁，避免并发下载把额度扣成负数

### 4.3 支付回调

```text
验签并记录事件指纹
  → 根据商户单号查询微信支付事实
  → 锁定订单与支付尝试
  → 校验金额、币种、付款人和订单归属
  → 更新订单与支付尝试状态
  → 写 pindou_quota_transactions(amount > 0, order_id = order.id)
提交事务
```

定时 reconciliation 会重新查询过期的 `ISSUED` / `UNKNOWN` 尝试；订单创建 5 分钟后，微信确认未支付或已关闭时立即关闭支付尝试和本地订单。查询失败或状态不明确时保持待核实且不可继续支付当前订单；微信确认已支付的迟到推送仍可将本地订单纠正为 `paid` 并发放权益。

## 5. 关键索引与约束汇总

| 对象 | 约束/索引 | 目的 |
| --- | --- | --- |
| `pindou_users` | `openid_hash UNIQUE` | 当前有效账号登录幂等建用户；注销后清空标识以支持重新注册 |
| `pindou_auth_sessions` | `token_hash UNIQUE`、`expires_at` | 快速鉴权与过期清理 |
| `pindou_works` | `(user_id, updated_at)` | 作品列表 |
| `pindou_work_patterns` | `work_id PK/FK` | 一对一图案恢复 |
| `pindou_favorites` | `(user_id, work_id) UNIQUE`；有效收藏 `(user_id, favorited_at DESC) WHERE deleted_at IS NULL` | 收藏操作幂等及最近收藏查询 |
| `pindou_download_records` | `idempotency_key UNIQUE` | 下载重试不重复扣费 |
| `pindou_quota_transactions` | 每日免费发放唯一 | 防止重复发放 |
| `pindou_orders` | `(user_id, idempotency_key) UNIQUE`；`(user_id, expires_at) WHERE status = 'pending'` | 订单创建幂等与待支付过期查询 |
| `pindou_payment_attempts` | `out_trade_no UNIQUE`、`wechat_transaction_id UNIQUE` | 防止支付尝试或交易号重复绑定 |
| `pindou_payment_events` | `(provider, event_fingerprint) UNIQUE` | 防止支付推送重复处理 |

所有外键都要配合用户归属校验；不能因为存在外键就省略 `user_id` 条件

## 6. 删除、保留与隐私边界

- 作品删除后，推荐软删除 `pindou_works`，避免下载记录因外键级联而失去审计上下文
- `pindou_download_records` 保留标题快照和文件类型；第一版不能重新下载已导出文件
- `pindou_quota_transactions` 和已支付 `pindou_orders` 不删除，用于支付和额度追溯
- 原始图片不上传，因此没有原始图片保留周期问题
- 封面对象存储可以在作品删除后异步清理；清理失败应进入重试队列或人工清理清单
- `openid`、session key、token 等敏感信息不进入 API 响应或普通日志
- 第一版不实现云同步开关；不要在数据库中把 `privacy_cloud_sync` 作为影响作品写入的条件

## 7. 历史作品恢复流程

```text
GET /api/works/:id
  → 返回 WorkSummary 字段 + pattern
  → 客户端校验 schemaVersion
  → 将 palette + cells 转成 PatternCell[]
  → sourceImagePath 置空
  → 打开结果页或编辑器
```

恢复保证：

- 不依赖客户端原来的 `draft-时间戳` id
- 不依赖已过期的 `wx` 临时文件路径
- 不需要重新上传原始图片
- `cells` 仍能精确恢复每一个颜色和透明格
- 材料清单由恢复后的图案重新聚合，避免重复存储

## 8. 从当前本地 Storage 到云端的边界

当前 `pindou-app-state-v1` 包含 `currentDraft`、本地 `works`、`favoriteIds`、`downloadQuota` 和 `downloadRecords`接入本设计后：

| 当前本地字段 | 第一版处理 |
| --- | --- |
| `currentDraft` | 继续作为临时编辑缓存；保存时转换为 `PersistedPattern` |
| 本地 `works` | 登录后从 `/api/works` 获取摘要；不再作为云端权威 |
| `favoriteIds` | 从 `/api/favorites` 获取；写操作调用收藏接口 |
| `downloadQuota` | 从 `/api/quota/me` 获取；禁止本地加减作为事实 |
| `downloadRecords` | 从 `/api/downloads` 获取；本地仅可做短暂缓存 |
| `privacyPreferences` | 第一版不通过 API 同步 `cloudSync`；保留本地 UI 设置但不改变服务端保存规则 |

匿名用户已有的本地作品不自动静默上传若产品决定支持迁移，应由客户端展示确认后，逐个上传封面并调用 `POST /api/works`，这不改变本数据库设计

## 9. 暂不建模的对象

以下对象不属于第一版数据库：

- `generation_tasks`：没有服务端图片量化任务
- `download_files`：没有服务器生成或托管下载文件
- `feedbacks`：意见反馈由微信小程序客服会话承载，不在服务端建模
- `public_work_shares`：未开放他人查看作品
- `privacy_preferences`：云同步开关语义未收敛

## 10. 建库前验收清单

- 使用 128×128 图案时，`cells_json` 是 16384 个整数，而不是 16384 个对象
- `palette_json` 与 `cells_json` 能完整还原颜色、颜色编号和透明格
- `pindou_works` 列表查询不会加载完整图案 JSON
- `GET /api/works/:id` 能只依赖数据库记录恢复历史作品，不依赖原图
- 服务端能从 `pindou_quota_transactions` 重建今日免费剩余和购买额度
- 同一支付订单重复回调不会重复增加额度
- 同一下载幂等键重试不会重复写扣减流水
- 作品、收藏、下载记录、额度和订单都能通过 `user_id` 做归属审计
