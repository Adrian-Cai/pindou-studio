# Ponytail 优化计划

> 来源：`.agents/skills/ponytail-review/SKILL.md`
>
> 目标：减少不必要复杂度、重复代码、单实现抽象和可直接删除的冗余内容。在不改变当前业务行为的前提下，让代码更短、更直接、更容易维护。

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

不用于判断正确性、安全性和性能问题。

---

## 2. 明天优先处理

### P0-1 删除无意义空文件

文件：

- `TEST_AGENT.md`

问题：

当前文件为空，没有配置、规则或执行价值。

处理：

- 直接删除。

预期收益：

- 减少仓库噪音。

风险：低。

---

### P0-2 删除单实现 Service Interface

文件：

- `server/src/modules/works/work-service.ts`
- `server/src/modules/downloads/quota-download-service.ts`

当前存在：

- `WorkService` -> 只有 `PostgresWorkService` 一个实现
- `QuotaDownloadService` -> 只有 `PostgresQuotaDownloadService` 一个实现

问题：

当前没有第二种存储实现，也没有明确的多实现需求，接口层只是增加类型和跳转成本。

处理建议：

- 删除 `WorkService` interface。
- 删除 `QuotaDownloadService` interface。
- 调用方直接依赖当前 concrete service。
- 等真正出现第二种实现后再抽象。

原则：

不要额外引入 Repository、BaseService 或 DI 框架替代当前接口，否则会从一种过度设计变成另一种过度设计。

风险：低到中。

验证：

- server typecheck
- server test
- server build

---

### P0-3 合并 works 所有权查询

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

保留一个最小的 ownership helper，返回 ownership row 或直接按业务约束抛错。

不要建立 OwnershipService / Repository。

预期收益：

- 删除一份重复 SQL 和判断流程。
- 后续权限语义只维护一个地方。

风险：低。

---

### P0-4 收缩作品列表重复分页逻辑

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

只提取一个非常小的内部 helper，用于共享分页参数或公共结果转换。

不要创建：

- BaseRepository
- QueryBuilder class
- GenericPaginationService
- SQL DSL

如果抽取后的 helper 比重复代码本身更难读，则宁可只消除最明显的重复部分。

风险：中。

验证：

- 普通作品列表
- status 过滤
- query 搜索
- 收藏列表
- 分页 total

---

### P0-5 简化客户端云端作品保存重复代码

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

保留 create / update 两个公开函数作为清晰业务入口。

不要额外创建 CloudWorkRepository 或 CloudWorkClient class。

风险：低。

---

## 3. 第二优先级优化

### P1-1 项目筛选菜单删除重复数组

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

避免同一映射两处维护。

风险：低。

---

### P1-2 评估客户端 Runtime Schema Validation

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

客户端与自建后端之间维护了接近一套完整 runtime schema，代码量较大。

但这部分承担真实 API 边界保护，因此不能为了减少行数直接删除。

明天只做评估，不建议第一轮立即修改。

可选方向：

1. 保留关键边界字段校验，删除重复或低价值校验。
2. 如果未来 API schema 能自动生成，再统一处理。
3. 不要为了减少手写代码引入大型 schema validation 依赖。

风险：中到高。

---

### P1-3 评估 works update 的完整 Pattern 重验

文件：

- `server/src/modules/works/work-service.ts`

当前即使只修改 title/status，在没有传入新 pattern 时，也会执行：

`mapPattern(existing) -> validatePersistedPattern()`

并继续重新写 width / height / beadCount / colorCount / brand。

优化方向：

如果本次请求没有修改 pattern：

- 保持已有 pattern 派生字段不变。
- 不重新构造和校验整份图案。

如果修改 pattern：

- 继续执行完整 validation 和派生字段更新。

这项修改涉及 SQL update 语义，需单独做，不与其他重构混在同一次提交里。

风险：中。

---

### P1-4 评估 create 的幂等并发流程

文件：

- `server/src/modules/works/work-service.ts`

当前 create 流程：

1. 根据 idempotencyKey 生成 workId
2. 先查询 existing
3. INSERT ... ON CONFLICT DO NOTHING
4. insert 未成功时再次 readWorkDetail
5. 再比较 sameRequest

该流程完整但偏重。

优化前必须先检查现有：

- 幂等测试
- 并发测试
- 数据库唯一约束

只有确认数据库约束和已有测试覆盖后，才能考虑缩短为：

`INSERT / RETURNING -> 冲突时读取 existing -> 验证请求是否一致`

这项不是明天第一批必改项。

风险：中到高。

---

## 4. 可选的小优化

### 日期格式化

文件：

- `miniprogram/pages/projects/index.ts`

当前 `formatDateTime()` 手动拼接日期时间。

只有在确认目标微信基础库可靠支持 `Intl.DateTimeFormat` 后，才考虑使用原生能力替代。

如果兼容性不明确，保持现状。

不要为了这一点引入日期库。

---

### 后端通用小函数

当前多个 service 内存在类似：

- rollback transaction
- Date/String -> ISO

可以考虑放入已有 `server/src/shared/`。

约束：

- 只移动明显重复的小函数。
- 不创建 BaseService。
- 不创建 UtilsManager。
- 不建立复杂共享基础设施。

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

这些文件虽然数量较多，但每个文件都较小，而且直接对应算法职责，不属于无意义抽象。

不要为了减少文件数量重新合成大文件。

---

### 后端业务模块结构保持不动

当前：

- auth
- downloads
- files
- users
- works

这些是真实业务边界，不属于 Ponytail 所说的 speculative abstraction。

不要合并成单个大 service。

---

## 6. 建议执行顺序

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

执行完整 works 相关测试。

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

> 优化后代码应该更少、更直接，而不是只是把复杂度换了一个地方。

---

## 8. 本次预期收益

第一轮保守目标：

- 预计减少约 150～250 行代码。
- 删除无实际用途的接口和重复流程。
- 保持所有现有业务行为不变。
- 不新增第三方依赖。
- 不新增基础框架或通用抽象层。

重点不是追求行数，而是确保每一层代码都有当前真实需求支撑。
