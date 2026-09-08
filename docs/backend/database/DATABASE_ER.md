# 一起拼豆吧 · 当前数据库 ER 图

> 状态：当前 Schema 关系视图
>
> 字段、类型与约束的完整清单见 `docs/backend/database/DATABASE_SCHEMA.md`；可执行契约见 `server/src/db/schema-contract.ts`

## ER 图

```mermaid
erDiagram
    pindou_users ||--o{ pindou_auth_sessions : has
    pindou_users ||--o{ pindou_file_assets : owns
    pindou_users ||--o{ pindou_works : owns
    pindou_users ||--o{ pindou_favorites : creates
    pindou_users ||--o{ pindou_download_records : downloads
    pindou_users ||--o{ pindou_quota_transactions : owns
    pindou_users ||--o{ pindou_orders : places

    pindou_file_assets ||--o{ pindou_works : cover_for
    pindou_works ||--|| pindou_work_patterns : has
    pindou_works ||--o{ pindou_favorites : favorited
    pindou_works o|--o{ pindou_download_records : source

    pindou_download_records o|--o| pindou_quota_transactions : debit
    pindou_orders o|--o{ pindou_quota_transactions : grants
    pindou_packages o|--o{ pindou_orders : selected_by

    pindou_users {
      varchar32 id PK
      varchar128 openid_hash UK
      text openid_ciphertext
      varchar80 nickname
      text avatar_url
      timestamptz created_at
      timestamptz updated_at
      timestamptz deleted_at
    }

    pindou_auth_sessions {
      varchar32 id PK
      varchar32 user_id FK
      varchar128 token_hash UK
      timestamptz expires_at
      timestamptz revoked_at
      timestamptz created_at
      timestamptz last_used_at
    }

    pindou_file_assets {
      varchar32 id PK
      varchar32 user_id FK
      varchar20 file_type
      varchar512 object_key UK
      text public_url
      varchar100 content_type
      bigint byte_size
      int width
      int height
      timestamptz created_at
      timestamptz deleted_at
    }

    pindou_works {
      varchar32 id PK
      varchar32 user_id FK
      varchar120 title
      varchar32 cover_file_id FK
      smallint width
      smallint height
      int bead_count
      smallint color_count
      varchar40 brand
      varchar20 status
      timestamptz created_at
      timestamptz updated_at
      timestamptz deleted_at
    }

    pindou_work_patterns {
      varchar32 work_id PK_FK
      smallint schema_version
      smallint width
      smallint height
      smallint color_limit
      varchar40 brand
      jsonb palette_json
      jsonb cells_json
      timestamptz created_at
      timestamptz updated_at
    }

    pindou_favorites {
      varchar32 user_id PK_FK
      varchar32 work_id PK_FK
      timestamptz created_at
    }

    pindou_download_records {
      varchar32 id PK
      varchar32 user_id FK
      varchar32 work_id FK
      varchar120 work_title_snapshot
      varchar20 file_type
      bool consumed_quota
      varchar32 quota_transaction_id FK
      varchar128 idempotency_key UK
      timestamptz downloaded_at
    }

    pindou_quota_transactions {
      varchar32 id PK
      varchar32 user_id FK
      varchar30 type
      int amount
      varchar40 source
      varchar20 bucket
      date quota_date
      varchar32 order_id FK
      varchar32 download_record_id FK
      varchar128 idempotency_key
      varchar255 note
      timestamptz created_at
    }

    pindou_packages {
      varchar40 id PK
      varchar80 label
      int quota_amount
      varchar30 membership_type
      int membership_days
      int price_fen
      varchar3 currency
      bool enabled
      int sort_order
      timestamptz created_at
      timestamptz updated_at
    }

    pindou_orders {
      varchar32 id PK
      varchar32 user_id FK
      varchar40 package_id FK
      varchar80 package_label_snapshot
      int quota_amount_snapshot
      varchar30 membership_type_snapshot
      int price_fen
      varchar20 status
      varchar128 wx_prepay_id
      varchar128 wx_transaction_id UK
      timestamptz paid_at
      timestamptz created_at
      timestamptz updated_at
    }
```

## 关系说明

- 用户是一切用户数据的归属根节点
- 一份作品对应一份 `pindou_work_patterns`，作品列表与完整图案分开存储
- 收藏是用户与作品之间的关系表
- 下载记录可以在作品被删除后保留，因此 `work_id` 允许为空并保留标题快照
- 额度余额不直接存在用户表，以 `pindou_quota_transactions` 流水汇总为准
- 下载扣减通过 `download_record_id` 与额度流水关联
- 购买额度通过订单与额度流水关联

## 维护规则

新增、删除或修改数据库表/字段时，应同步更新：

1. PostgreSQL Schema / migration
2. `server/src/db/schema-contract.ts`
3. `docs/backend/database/DATABASE_SCHEMA.md`
4. 本 ER 图
5. `docs/releases/CHANGELOG.md`
