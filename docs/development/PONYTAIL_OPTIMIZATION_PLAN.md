# Ponytail 优化计划

> 来源：`.agents/skills/ponytail-review/SKILL.md`
>
> 目标：减少不必要复杂度、重复代码、单实现抽象和可直接删除的冗余内容在不改变当前业务行为的前提下，让代码更短、更直接、更容易维护

## 1. 本次扫描范围

本次针对整个 `pindou-studio` 仓库进行了 Ponytail Review，重点覆盖：

- 微信小程序主包页面
- 微信小程序 services
- Pattern Engine 目录
- 后端 modules
- works / downloads 核心业务代码
- 仓库文档结构

Ponytail Review 只检查：

- 可以直接删除的代码
- 重复造轮子
- 可以使用标准库或平台原生能力替代的实现
- 无必要依赖
- 投机式抽象
- YAGNI
- 可以明显缩短的实现

不用于判断正确性、安全性和性能问题

---

## 1.5 执行状态总览（2026-09-23 回填）

本计划于 2026-09-08（`5da6e67`）定稿，此后代码陆续落地但文档未同步。下表是 2026-09-23 全量核查的结果，逐项结论也已回填到对应小节。

| 项 | 状态 | 说明 |
| --- | --- | --- |
| P0-1 删除空文件 | 已完成 | `TEST_AGENT.md` 已删除 |
| P0-2 删除单实现接口 | 已完成 | 调用方已直接依赖 concrete service |
| P0-3 合并所有权查询 | 已完成 | 只保留 `assertWorkOwner` 一个 helper |
| P0-4 收缩列表分页重复 | 部分完成 | 已抽 `mapListResponse`，SQL 层重复经评估后建议保留 |
| P0-5 云端保存去重 | 已完成 | 已抽 `persistCloudWork` |
| P1-1 tabs 去重 | 已完成 | 改用 `tabs[tapIndex]?.id` |
| P1-2 runtime schema 校验 | 保持现状 | 计划只要求评估，代码未动 |
| P1-3 update pattern 重验 | 已实现 | 仅在传了 pattern 时才重验 |
| P1-4 create 幂等流程 | 不做 | 影响面评估后判定收益小于风险 |
| 日期格式化 | 保持现状 | 基础库兼容性不明确，按计划不动 |
| 后端小函数收 shared | 已完成 | `transaction` / `date-time` / `app-error` / `identity` 已就位 |

---

## 2. 明天优先处理

### P0-1 删除无意义空文件

> **状态：已完成** —— `TEST_AGENT.md` 已删除，仓库内不再有该文件。

文件：

- `TEST_AGENT.md`

问题：

当前文件为空，没有配置、规则或执行价值

处理：

- 直接删除

预期收益：

- 减少仓库噪音

风险：低

---

### P0-2 删除单实现 Service Interface

> **状态：已完成** —— `WorkService` 与 `QuotaDownloadService` 两个 interface 均已删除；`src/index.ts`、`src/http/app.ts` 直接依赖 `PostgresWorkService` / `PostgresQuotaDownloadService`，未引入 Repository 或 DI 框架替代。

文件：

- `server/src/modules/works/work-service.ts`
- `server/src/modules/downloads/quota-download-service.ts`

当前存在：

- `WorkService` -> 只有 `PostgresWorkService` 一个实现
- `QuotaDownloadService` -> 只有 `PostgresQuotaDownloadService` 一个实现

问题：

当前没有第二种存储实现，也没有明确的多实现需求，接口层只是增加类型和跳转成本

处理建议：

- 删除 `WorkService` interface
- 删除 `QuotaDownloadService` interface
- 调用方直接依赖当前 concrete service
- 等真正出现第二种实现后再抽象

原则：

不要额外引入 Repository、BaseService 或 DI 框架替代当前接口，否则会从一种过度设计变成另一种过度设计

风险：低到中

验证：

- server typecheck
- server test
- server build

---

### P0-3 合并 works 所有权查询

> **状态：已完成** —— `throwOwnershipAwareNotFound` 已删除，只保留 `assertWorkOwner(pool, workId, userId)` 一个 helper。

文件：

- `server/src/modules/works/work-service.ts`

当前重复逻辑：

- `throwOwnershipAwareNotFound()`
- `assertWorkOwner()`

两者都查询：

```sql
SELECT user_id, deleted_at FROM pindou_works WHERE id = $1 LIMIT 1
```

然后判断：

- 作品不存在
- 已删除
- 不属于当前用户

处理建议：

保留一个最小的 ownership helper，返回 ownership row 或直接按业务约束抛错

不要建立 OwnershipService / Repository

预期收益：

- 删除一份重复 SQL 和判断流程
- 后续权限语义只维护一个地方

风险：低

---

### P0-4 收缩作品列表重复分页逻辑

> **状态：部分完成** —— 已抽出 `mapListResponse()` 共享 total / page / pageSize / items 转换；conditions、COUNT、SELECT、JOIN、LIMIT/OFFSET 仍两处各写一遍。是否继续见本节末尾评估，结论是停在这里。

文件：

- `server/src/modules/works/work-service.ts`

重复位置：

- `list()`
- `listFavorites()`

重复内容包括：

- conditions 数组
- parameters 数组
- query 搜索条件
- COUNT 查询
- pageSize / OFFSET
- 作品公共字段 SELECT
- file_assets JOIN
- total 转换
- `mapSummary`

处理建议：

只提取一个非常小的内部 helper，用于共享分页参数或公共结果转换

不要创建：

- BaseRepository
- QueryBuilder class
- GenericPaginationService
- SQL DSL

如果抽取后的 helper 比重复代码本身更难读，则宁可只消除最明显的重复部分

风险：中

验证：

- 普通作品列表
- status 过滤
- query 搜索
- 收藏列表
- 分页 total

#### 后续评估（2026-09-23）：停在这里，不再往下收

**影响面**

- `GET /api/works` → `works.list()` → `fetchCloudWorks()` → `miniprogram/pages/projects/index.ts`、`miniprogram/store/auth-store.ts`
- `GET /api/favorites` → `works.listFavorites()` → `fetchCloudFavorites()` → `miniprogram/packages/account/favorites/index.ts`、`miniprogram/store/auth-store.ts`
- 护栏测试 `server/test/favorites-service.test.js:134-135` **直接断言参数数组内容**（`[userId, %query%]` 与 `[userId, %query%, pageSize, offset]`），改动参数 push 顺序必红
- 真库分页测试在 `server/test/stage3-database-integration.test.js`，需 `RUN_DATABASE_INTEGRATION=1`，默认 skip

**真正可共享的只有三块（约 15～20 行）**

- 除 `is_favorite` 外的公共 SELECT 列（12 个字段，两侧 `works.` 前缀一致）
- cover 的 `LEFT JOIN pindou_file_assets files ON ...` 一行
- 分页参数 push 与 `LIMIT` / `OFFSET` 占位符推算

**看着重复但实质不同，不该合并**

- FROM 主表与 JOIN：收藏侧多一个 `works.user_id = favorites.user_id`，是防跨用户读取的实质条件
- conditions 基数组：别名与条件数都不同
- `ORDER BY`：`updated_at` vs `favorited_at`
- COUNT 的 FROM
- `is_favorite`：list 用 `EXISTS` 子查询，listFavorites 用 `TRUE` 常量

**风险不在行数，在参数下标**

- `LIMIT $<length-1> OFFSET $<length>` 依赖 `parameters` 数组长度推算
- list 的 `EXISTS(... favorites.user_id = $1 ...)` 硬编码 userId 永远是 `$1`
- 拆成常量 / helper 后，「参数顺序必须与 SQL 文本对齐」从肉眼可对照的连续代码，变成跨符号的隐式契约

**结论**：`mapListResponse` 已经吃掉收益最大的部分。最多再抽 cover JOIN 那一行的常量（纯文本替换、零参数耦合），其余不动 —— 省 20 行不值得换一个只有跑起来才暴露的坑。

---

### P0-5 简化客户端云端作品保存重复代码

> **状态：已完成** —— 已抽出文件内部使用的 `persistCloudWork()`（含 token、cover 上传、request 组装、summary 解析），`saveNewCloudWork` / `updateCloudWork` 各剩一行委托，未新建 CloudWorkRepository 或 Client class。

文件：

- `miniprogram/services/work-service.ts`

重复位置：

- `saveNewCloudWork()`
- `updateCloudWork()`

共同流程：

1. require token
2. upload cover
3. draft -> persisted pattern
4. API request
5. parse summary

处理建议：

提取一个仅在该文件内部使用的小函数，例如负责：

- token
- cover upload
- request data 组装
- summary parse

保留 create / update 两个公开函数作为清晰业务入口

不要额外创建 CloudWorkRepository 或 CloudWorkClient class

风险：低

---

## 3. 第二优先级优化

### P1-1 项目筛选菜单删除重复数组

> **状态：已完成** —— `showFilter()` 改用 `tabs[tapIndex]?.id`，硬编码数组已删除。

文件：

- `miniprogram/pages/projects/index.ts`

当前顶部已经存在：

```ts
const tabs = [
  { id: 'all', label: '全部' },
  { id: 'recent', label: '最近' },
  { id: 'draft', label: '草稿' },
  { id: 'completed', label: '已完成' },
]
```

但 `showFilter()` 又维护：

```ts
['all', 'recent', 'draft', 'completed']
```

处理：

直接使用：

```ts
const tab = tabs[tapIndex]?.id
```

避免同一映射两处维护

风险：低

---

### P1-2 评估客户端 Runtime Schema Validation

> **状态：保持现状** —— 按计划只做评估、第一轮不修改。手写校验（`isRecord` / `isFiniteNumber` / `parseWorkSummary` 等）仍在，承担真实 API 边界保护，未引入 schema 依赖。

文件：

- `miniprogram/services/work-service.ts`

当前存在较完整的手写 response validation：

- `isRecord`
- `isFiniteNumber`
- `parseWorkSummary`
- `parseWorkDetail`
- `parsePersistedPattern`
- `invalidResponse`

问题：

客户端与自建后端之间维护了接近一套完整 runtime schema，代码量较大

但这部分承担真实 API 边界保护，因此不能为了减少行数直接删除

明天只做评估，不建议第一轮立即修改

可选方向：

1. 保留关键边界字段校验，删除重复或低价值校验
2. 如果未来 API schema 能自动生成，再统一处理
3. 不要为了减少手写代码引入大型 schema validation 依赖

风险：中到高

---

### P1-3 评估 works update 的完整 Pattern 重验

> **状态：已实现** —— `update()` 仅在 `validatedPattern !== undefined` 时重写 `pindou_work_patterns`，派生字段一律 `pattern?.x ?? existing.x`；只改 title / status 不再重新构造和校验整份图案。

文件：

- `server/src/modules/works/work-service.ts`

当前即使只修改 title/status，在没有传入新 pattern 时，也会执行：

`mapPattern(existing) -> validatePersistedPattern()`

并继续重新写 width / height / beadCount / colorCount / brand

优化方向：

如果本次请求没有修改 pattern：

- 保持已有 pattern 派生字段不变
- 不重新构造和校验整份图案

如果修改 pattern：

- 继续执行完整 validation 和派生字段更新

这项修改涉及 SQL update 语义，需单独做，不与其他重构混在同一次提交里

风险：中

---

### P1-4 评估 create 的幂等并发流程

> **状态：不做** —— 影响面评估见本节末尾：收益小于风险，且改动会让所有幂等命中走进一条零测试覆盖的分支。

文件：

- `server/src/modules/works/work-service.ts`

当前 create 流程：

1. 根据 idempotencyKey 生成 workId
2. 先查询 existing
3. INSERT ... ON CONFLICT DO NOTHING
4. insert 未成功时再次 readWorkDetail
5. 再比较 sameRequest

该流程完整但偏重

优化前必须先检查现有：

- 幂等测试
- 并发测试
- 数据库唯一约束

只有确认数据库约束和已有测试覆盖后，才能考虑缩短为：

`INSERT / RETURNING -> 冲突时读取 existing -> 验证请求是否一致`

这项不是明天第一批必改项

风险：中到高

#### 后续评估（2026-09-23）：不做

**先补两个查证到的事实**

- `pindou_works` **没有 `idempotency_key` 列，也没有 `(user_id, idempotency_key)` 唯一索引**；幂等完全靠 `HMAC(userId, key)` 派生确定性 id + `pindou_works.id` 主键唯一（`server/src/db/schema-contract.ts:224`）。数据库层面的保障只有主键这一个
- `server/test/works-service.test.js:163` 是唯一的幂等单测，但它的 stub 让第二次调用直接命中「existing 分支」，`work-service.ts` 中 `if (!inserted)` 的并发回退分支**零覆盖**；没有并发测试；stage2 / stage3 集成测试不测 works create 幂等，且默认 skip

**计划提出的简化**：删掉开头的 `readWorkDetail()`，改为 INSERT 优先、冲突再读。代价有三条：

- **幂等会在最该生效的时候失效**：删掉前置查询后 cover 校验必须提前（INSERT 需要 `cover_file_id`），于是「幂等键已存在、但 cover 文件已被软删」的重试，从「返回首次结果」退化为 404
- **重试路径变慢**：幂等命中是高频路径（网络抖动重试），现在一次 SELECT 就返回，改后变成一次 INSERT（撞主键、拿行锁）+ 一次 SELECT，把成本从冷路径搬到了热路径
- **收益只有**「首次创建少一次 SELECT」，而并发安全性没有任何提升 —— 两条路径都依赖 `ON CONFLICT (id)` + 主键

**最关键的一条**：改完之后，所有幂等命中都会走进那条零测试覆盖的分支。

**结论**：不做。若一定要动，前置条件是先补并发回退分支的单测与一个真库幂等测试 —— 而补测试的成本已经超过省下的那次查询。

---

## 4. 可选的小优化

### 日期格式化

文件：

- `miniprogram/pages/projects/index.ts`

当前 `formatDateTime()` 手动拼接日期时间

只有在确认目标微信基础库可靠支持 `Intl.DateTimeFormat` 后，才考虑使用原生能力替代

如果兼容性不明确，保持现状

不要为了这一点引入日期库

---

### 后端通用小函数

当前多个 service 内存在类似：

- rollback transaction
- Date/String -> ISO

可以考虑放入已有 `server/src/shared/`

约束：

- 只移动明显重复的小函数
- 不创建 BaseService
- 不创建 UtilsManager
- 不建立复杂共享基础设施

---

## 5. 明确不优化的地方

### Pattern Engine 当前文件拆分保持不动

目录：

`miniprogram/services/pattern-generation/`

当前：

- `cell-sampler.ts`
- `color-space.ts`
- `color-utils.ts`
- `crop.ts`
- `median-cut.ts`
- `standard-generator.ts`

这些文件虽然数量较多，但每个文件都较小，而且直接对应算法职责，不属于无意义抽象

不要为了减少文件数量重新合成大文件

---

### 后端业务模块结构保持不动

当前：

- auth
- downloads
- files
- users
- works

这些是真实业务边界，不属于 Ponytail 所说的 speculative abstraction

不要合并成单个大 service

---

## 6. 建议执行顺序

> 注：以下是 2026-09-08 定稿时的原始计划。2026-09-23 核查后的实际结果见 §1.5 —— Stage 1～4 已完成，
> Stage 5 中 P1-3 已落地、P1-2 保持现状、P1-4 经评估判定不做。

明天建议严格按下面顺序分阶段执行，每一阶段单独检查：

### Stage 1：零风险清理

- 删除 `TEST_AGENT.md`
- projects tabs 去重

执行：

- typecheck

### Stage 2：后端单实现接口清理

- 删除 WorkService
- 删除 QuotaDownloadService

执行：

- server typecheck
- server test
- server build

### Stage 3：works 重复逻辑

- 合并 ownership helper
- 收缩 list/listFavorites 重复代码

执行完整 works 相关测试

### Stage 4：客户端 work-service

- 合并 create/update 重复保存流程

执行：

- root typecheck
- 小程序主要作品流程验证

### Stage 5：高风险候选评估

只评估，不强制修改：

- runtime schema validation
- works update pattern 重验
- create 幂等流程

---

## 7. 每次修改后的提交规则

每个阶段完成后：

1. typecheck / test / build
2. 正常正确性 review
3. 执行 `.agents/skills/ponytail-review/SKILL.md`
4. 如果 review 后又进行了实质修改，再执行一次 ponytail-review
5. 确认没有为了“优化复杂度”引入新的抽象
6. 再提交

Ponytail 的判断标准：

> 优化后代码应该更少、更直接，而不是只是把复杂度换了一个地方

---

## 8. 本次预期收益

第一轮保守目标：

- 预计减少约 150～250 行代码
- 删除无实际用途的接口和重复流程
- 保持所有现有业务行为不变
- 不新增第三方依赖
- 不新增基础框架或通用抽象层

重点不是追求行数，而是确保每一层代码都有当前真实需求支撑

---

## 9. 文档状态

本计划 2026-09-08（`5da6e67`）定稿后，代码陆续落地但文档一直未同步，读起来会以为全都还没开始。
2026-09-23 全量核查一次，结论已按项回填到上文各小节，并在 §1.5 给出总览：

- P0 五项 + P1-1 / P1-3 均已落地
- P0-4 只做到「共享结果转换」这一层，SQL 层重复经评估后建议保留
- P1-2 按计划仅需评估，代码保持现状
- P1-4 经影响面评估后判定不做，理由见该节末尾

Ponytail 的判断标准依然适用：

> 优化后代码应该更少、更直接，而不是只是把复杂度换了一个地方

按这个标准，P0-4 与 P1-4 若继续推进，都是「复杂度换了个地方」甚至「换到了更危险的地方」，因此收在这里。
