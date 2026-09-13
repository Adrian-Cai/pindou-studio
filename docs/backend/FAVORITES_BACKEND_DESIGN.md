# 收藏功能后端设计方案

> 文档状态：已实现（0.26.0 / 后端 0.15.0）
>
> 适用范围：`pindou_favorites`、作品收藏状态、收藏列表、收藏时间语义
>
> 关联接口：`PATCH /api/works/:id/favorite`、`GET /api/favorites`、`GET /api/works`、`GET /api/works/:id`
>
> 设计目标：为收藏功能后端开发提供统一的数据模型、接口语义、迁移步骤和验收标准

## 1. 背景与当前问题

当前后端已经具备收藏接口和 `PostgresWorkService.setFavorite()` / `listFavorites()`，但当前实现仍有两处需要收敛：

1. 取消收藏会物理删除 `pindou_favorites` 记录，无法保留历史关系；
2. 收藏列表页面当前容易误用作品的 `updatedAt`，而 `pindou_works.updated_at` 表示作品最后修改时间，不是收藏时间。

当前 `pindou_favorites` 只有：

```text
user_id
work_id
created_at
```

当前设计需要升级为“收藏关系永久保留 + 当前状态软删除 + 收藏时间独立表达”。

## 2. 核心设计结论

### 2.1 收藏记录禁止物理删除

一旦 `(user_id, work_id)` 收藏关系写入数据库，业务代码不得再执行：

```sql
DELETE FROM pindou_favorites ...
```

取消收藏统一使用软删除：

```text
deleted_at = 当前服务端时间
```

重新收藏复用原来的同一条记录：

```text
deleted_at = NULL
favorited_at = 当前服务端时间
```

组合主键继续使用：

```text
(user_id, work_id)
```

因此同一用户和同一作品始终最多只有一条收藏关系记录。

### 2.2 作品更新时间与收藏时间彻底分离

`pindou_works.updated_at` 继续只表示：

> 作品最后一次内容修改时间。

收藏、取消收藏、重新收藏都不得更新 `pindou_works.updated_at`。

收藏页面的：

- 收藏时间展示；
- “最近收藏”判断；
- 按收藏时间排序；

全部使用：

```text
pindou_favorites.favorited_at
```

### 2.3 时间字段保持最小集合

目标表只增加两个字段：

```text
favorited_at
 deleted_at
```

不增加 `updated_at`。

原因：当前收藏关系只有“收藏 / 取消收藏”两种业务状态，`favorited_at` 与 `deleted_at` 已经能够完整表达当前需要的状态变化；额外增加通用 `updated_at` 暂无独立业务用途。

最终时间语义：

| 字段 | 含义 | 是否更新 |
| --- | --- | --- |
| `created_at` | 第一次建立收藏关系的时间 | 首次插入后永久不变 |
| `favorited_at` | 最近一次从未收藏/已取消状态进入收藏状态的时间 | 重新收藏时更新 |
| `deleted_at` | 当前这次取消收藏的时间 | 取消收藏时写入，重新收藏时清空 |

## 3. 目标数据库模型

`pindou_favorites` 目标结构：

| 字段 | PostgreSQL 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `user_id` | `varchar(32)` | 否 | 用户 ID |
| `work_id` | `varchar(32)` | 否 | 作品 ID |
| `created_at` | `timestamptz` | 否 | 首次收藏关系创建时间，永久不变 |
| `favorited_at` | `timestamptz` | 否 | 最近一次有效收藏时间 |
| `deleted_at` | `timestamptz` | 是 | 取消收藏时间；`NULL` 表示当前有效收藏 |

约束保持：

```text
PRIMARY KEY (user_id, work_id)
FOREIGN KEY user_id -> pindou_users.id
FOREIGN KEY work_id -> pindou_works.id
```

当前有效收藏的唯一判断方式：

```sql
deleted_at IS NULL
```

不能再通过“数据库里是否存在一行”直接判断是否收藏。

## 4. Migration 设计

### 4.1 Additive migration

先做向后兼容的加字段：

```sql
ALTER TABLE pindou_favorites
  ADD COLUMN favorited_at timestamptz,
  ADD COLUMN deleted_at timestamptz;
```

### 4.2 历史数据回填

现有收藏记录都属于当前有效收藏，因此：

```sql
UPDATE pindou_favorites
SET favorited_at = created_at
WHERE favorited_at IS NULL;
```

随后增加非空约束：

```sql
ALTER TABLE pindou_favorites
  ALTER COLUMN favorited_at SET NOT NULL;
```

`deleted_at` 保持可空。

### 4.3 索引

收藏列表主要查询“当前用户的有效收藏，并按最近收藏时间倒序”，增加部分索引：

```sql
CREATE INDEX idx_pindou_favorites_active_recent
ON pindou_favorites (user_id, favorited_at DESC)
WHERE deleted_at IS NULL;
```

原 `(user_id, created_at)` 索引先保留，待上线后根据实际查询计划决定是否移除；本次不提前做破坏性索引清理。

### 4.4 Schema Contract

`server/src/db/schema-contract.ts` 中同步增加：

```ts
pindou_favorites: {
  user_id: column("varchar", false, 32),
  work_id: column("varchar", false, 32),
  created_at: column("timestamptz"),
  favorited_at: column("timestamptz"),
  deleted_at: column("timestamptz", true),
}
```

并增加当前有效收藏索引的 Schema Contract 校验。

## 5. 收藏状态机

```text
                  favorite=true
         ┌───────────────────────────┐
         │                           ▼
[无记录] ─────── INSERT ───────> [ACTIVE]
                                  deleted_at=NULL
                                  favorited_at=T1
                                       │
                                       │ favorite=false
                                       ▼
                                  [DELETED]
                                  deleted_at=T2
                                       │
                                       │ favorite=true
                                       ▼
                                  [ACTIVE]
                                  deleted_at=NULL
                                  favorited_at=T3
```

数据库中不存在真正的物理删除状态。

## 6. `setFavorite()` 设计

文件：

```text
server/src/modules/works/work-service.ts
```

接口保持：

```ts
setFavorite(userId: string, workId: string, favorite: boolean)
```

调用前继续执行作品所有权校验。

### 6.1 首次收藏

输入：

```json
{ "favorite": true }
```

数据库无记录时：

```text
INSERT
created_at   = now
favorited_at = now
deleted_at   = NULL
```

返回：

```json
{
  "workId": "work_xxx",
  "isFavorite": true,
  "favoritedAt": "2026-09-09T12:00:00.000Z"
}
```

### 6.2 已收藏状态重复收藏

当前：

```text
deleted_at IS NULL
```

再次请求：

```json
{ "favorite": true }
```

必须是幂等 NO-OP：

- 不新增记录；
- 不修改 `created_at`；
- 不刷新 `favorited_at`；
- 直接返回当前收藏状态。

否则网络重试会错误地改变收藏排序。

### 6.3 取消收藏

当前有效收藏时：

```sql
UPDATE pindou_favorites
SET deleted_at = $now
WHERE user_id = $userId
  AND work_id = $workId
  AND deleted_at IS NULL;
```

禁止任何 `DELETE FROM pindou_favorites`。

返回：

```json
{
  "workId": "work_xxx",
  "isFavorite": false,
  "favoritedAt": null
}
```

数据库中的历史 `favorited_at` 保留，但 API 在未收藏状态下返回 `null`，只表达当前状态。

### 6.4 重复取消收藏

如果已经：

```text
deleted_at IS NOT NULL
```

再次 `favorite=false` 必须保持幂等：

- 不修改原 `deleted_at`；
- 不新增记录；
- 返回 `isFavorite=false`。

如果数据库从未产生过收藏记录，`favorite=false` 也直接返回未收藏状态，不为了制造历史记录而插入 tombstone。

### 6.5 重新收藏

已有软删除记录时：

```sql
UPDATE pindou_favorites
SET favorited_at = $now,
    deleted_at = NULL
WHERE user_id = $userId
  AND work_id = $workId;
```

`created_at` 永远不修改。

示例：

```text
首次收藏  09-01 -> created_at=09-01, favorited_at=09-01, deleted_at=NULL
取消收藏  09-05 -> created_at=09-01, favorited_at=09-01, deleted_at=09-05
重新收藏  09-09 -> created_at=09-01, favorited_at=09-09, deleted_at=NULL
```

始终只有一条数据库记录。

## 7. 所有读取逻辑必须适配软删除

### 7.1 `isFavorite`

`GET /api/works` 与 `GET /api/works/:id` 当前通过 `EXISTS` 计算收藏状态。

目标条件必须包含：

```sql
EXISTS (
  SELECT 1
  FROM pindou_favorites favorites
  WHERE favorites.user_id = $1
    AND favorites.work_id = works.id
    AND favorites.deleted_at IS NULL
)
```

软删除历史记录不得导致 `isFavorite=true`。

### 7.2 收藏列表

`GET /api/favorites` 必须同时过滤：

```sql
favorites.deleted_at IS NULL
works.deleted_at IS NULL
```

排序：

```sql
ORDER BY favorites.favorited_at DESC, works.id DESC
```

不得使用：

```text
works.updated_at
favorites.created_at
```

作为当前收藏时间排序依据。

### 7.3 收藏数量统计

所有 `favoriteCount` / 收藏统计查询必须统一增加：

```sql
favorites.deleted_at IS NULL
```

如果统计与作品关联，还必须过滤：

```sql
works.deleted_at IS NULL
```

避免软删除收藏继续计入当前收藏数量。

## 8. 收藏列表 DTO

作品 DTO 保持：

```ts
interface WorkSummary {
  id: string
  title: string
  ...
  generationMode: 'standard' | 'ai'
  isFavorite: boolean
  createdAt: string
  updatedAt: string
}
```

收藏列表增加独立 DTO：

```ts
interface FavoriteWorkSummary extends WorkSummary {
  favoritedAt: string
}
```

`GET /api/favorites` 示例：

```json
{
  "total": 1,
  "page": 1,
  "pageSize": 20,
  "items": [
    {
      "id": "work_xxx",
      "title": "动漫少女",
      "coverUrl": "https://example.com/cover.png",
      "width": 64,
      "height": 64,
      "beadCount": 3200,
      "colorCount": 18,
      "brand": "MARD",
      "status": "completed",
      "isFavorite": true,
      "favoritedAt": "2026-09-09T12:00:00.000Z",
      "createdAt": "2026-09-01T10:00:00.000Z",
      "updatedAt": "2026-09-01T10:30:00.000Z"
    }
  ]
}
```

字段职责：

```text
createdAt   -> 作品创建时间
updatedAt   -> 作品最后修改时间
favoritedAt -> 当前这次收藏发生时间
```

## 9. API 契约

### 9.1 PATCH `/api/works/:id/favorite`

请求：

```json
{ "favorite": true }
```

收藏成功：

```json
{
  "workId": "work_xxx",
  "isFavorite": true,
  "favoritedAt": "2026-09-09T12:00:00.000Z"
}
```

取消收藏：

```json
{
  "workId": "work_xxx",
  "isFavorite": false,
  "favoritedAt": null
}
```

路径、鉴权方式和请求体不改变，客户端无需因为软删除修改调用方式。

### 9.2 GET `/api/favorites`

继续支持：

```text
page
pageSize
query
```

返回有效收藏，增加：

```text
favoritedAt
```

`favoritedAt` 使用服务端 ISO 8601 时间。

## 10. 作品删除与收藏关系

`pindou_works` 本身已经使用 `deleted_at` 软删除。

作品被软删除时：

- 不物理删除对应 `pindou_favorites`；
- 不要求同步修改收藏记录；
- 收藏列表通过 `works.deleted_at IS NULL` 隐藏该作品；
- 收藏统计同样排除已删除作品。

当前产品没有作品恢复能力，因此不额外设计收藏级联恢复逻辑。

## 11. 本地收藏迁移到云端

后端接口保持设置目标状态，而不是 toggle：

```json
{ "favorite": true }
```

这使客户端迁移具备天然幂等性。

本地作品完成云端保存后，如果客户端确认该本地作品原本已收藏：

```text
POST /api/works
  -> 获得 cloudWorkId
  -> PATCH /api/works/:cloudWorkId/favorite { favorite: true }
```

后端不负责理解客户端 `favoriteIds`，也不接受客户端传入 `userId`。

## 12. 并发与事务要求

收藏写入必须依赖数据库主键：

```text
PRIMARY KEY (user_id, work_id)
```

保证并发收藏不会产生重复记录。

建议 `favorite=true` 使用单条 `INSERT ... ON CONFLICT ... DO UPDATE` 或等价事务实现，并满足：

- 当前 ACTIVE 时不刷新 `favorited_at`；
- 当前 DELETED 时恢复并刷新 `favorited_at`；
- 不产生第二条关系记录。

`favorite=false` 的 UPDATE 必须带：

```sql
deleted_at IS NULL
```

保证重复取消不刷新 `deleted_at`。

## 13. 明确禁止事项

后端开发时禁止：

1. `DELETE FROM pindou_favorites`；
2. 收藏行为修改 `pindou_works.updated_at`；
3. 用 `pindou_favorites.created_at` 表示重新收藏时间；
4. 用 `pindou_works.updated_at` 作为收藏页面时间；
5. 仅凭收藏表存在记录就返回 `isFavorite=true`；
6. 重复 `favorite=true` 时刷新 `favorited_at`；
7. 重复 `favorite=false` 时刷新 `deleted_at`；
8. 为从未收藏过的 `(user_id, work_id)` 在 `favorite=false` 时创建无意义 tombstone。

## 14. 测试设计

### 14.1 数据库 / Service 测试

| 用例 | 验收 |
| --- | --- |
| 首次收藏 | 新增 1 行；三个时间字段符合定义；`deleted_at=NULL` |
| 重复收藏 | 行数不增加；`favorited_at` 不变化 |
| 取消收藏 | 行数不减少；仅写 `deleted_at` |
| 重复取消 | `deleted_at` 不变化 |
| 重新收藏 | 复用原行；`created_at` 不变；`favorited_at` 刷新；`deleted_at=NULL` |
| 从未收藏直接取消 | 不插入记录，返回未收藏 |
| 其他用户操作作品 | `403 FORBIDDEN` |
| 已删除作品 | 不允许建立新的有效收藏 |

### 14.2 查询测试

| 用例 | 验收 |
| --- | --- |
| ACTIVE 收藏 | `isFavorite=true` |
| DELETED 收藏 | `isFavorite=false` |
| 收藏列表 | 只返回 `deleted_at IS NULL` |
| 收藏排序 | 按 `favorited_at DESC` |
| 收藏数量 | 不统计软删除收藏 |
| 已删除作品 | 不出现在收藏列表与当前收藏统计 |

### 14.3 时间语义回归

重点回归：

```text
作品 updated_at = 2026-08-20
收藏 favorited_at = 2026-09-09
```

必须满足：

```text
GET /api/favorites -> favoritedAt = 2026-09-09
GET /api/works     -> updatedAt   = 2026-08-20
```

执行收藏和取消收藏前后：

```text
pindou_works.updated_at
```

必须保持不变。

## 15. 实施顺序

### Phase 1：数据库准备

1. 新增 migration；
2. 增加 `favorited_at` / `deleted_at`；
3. 回填历史数据；
4. 增加部分索引；
5. 更新 Schema Contract。

### Phase 2：后端写路径

1. 改造 `setFavorite()`；
2. 去除物理 DELETE；
3. 实现重复收藏 / 取消的幂等规则；
4. 补 Service 测试。

### Phase 3：后端读路径

1. 改造 Work `isFavorite`；
2. 改造 `listFavorites()`；
3. 改造收藏统计；
4. 返回 `favoritedAt`；
5. 补查询与接口测试。

### Phase 4：文档与客户端契约同步

1. 更新 `docs/backend/API_SPEC.md`；
2. 更新 `docs/backend/database/DATABASE_SCHEMA.md`；
3. 更新 `docs/backend/database/DATABASE_DESIGN.md` / ER 图；
4. 客户端收藏页从 `work.updatedAt` 切换到 `favoritedAt`。

## 16. 上线验收标准

以下条件全部满足才算收藏后端改造完成：

```text
1. pindou_favorites 不再发生业务物理 DELETE
2. 取消收藏只写 deleted_at
3. 重新收藏复用原记录
4. created_at 首次写入后永久保持
5. favorited_at 表示最近一次有效收藏时间
6. 软删除收藏不会返回 isFavorite=true
7. GET /api/favorites 不返回软删除收藏
8. 收藏列表按 favorited_at 排序
9. 收藏统计不包含软删除关系
10. 收藏/取消不修改 pindou_works.updated_at
11. 重复收藏和重复取消均满足幂等
12. 同一 user_id + work_id 始终最多一条收藏记录
```

## 17. 当前实现与目标实现对照

| 项目 | 当前实现 | 目标实现 |
| --- | --- | --- |
| 取消收藏 | `DELETE` | `UPDATE deleted_at` |
| 重新收藏 | 再次 INSERT | 恢复同一记录 |
| 首次关系时间 | `created_at` | `created_at`，永久不变 |
| 当前收藏时间 | `created_at` / 页面可能误用 Work 时间 | `favorited_at` |
| 收藏状态判断 | 是否存在关系 | `deleted_at IS NULL` |
| 收藏排序 | `favorites.created_at` | `favorites.favorited_at` |
| 作品更新时间 | 作品修改时间 | 保持原语义，不受收藏操作影响 |

---

最终原则：

> **收藏关系只允许 INSERT / UPDATE，不允许业务物理 DELETE；作品时间与收藏时间完全分离，当前收藏状态统一由 `deleted_at IS NULL` 判断。**
