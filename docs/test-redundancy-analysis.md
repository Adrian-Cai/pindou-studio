# `server/test` 冗余测试分析报告

> 分析范围：`server/test`（59 个 `*.test.js`，共 **310** 个用例，外加 1 个共享 helper `payment-test-helpers.js`）
> 分析方式：全量静态通读 + 逐条回查 `server/src`（TypeScript 源码）核对
> 说明：测试引用的是编译产物 `server/dist`；本报告判定"是否失效"一律以 `server/src` 当前源码为准。

---

## 一、结论速览

| 类别 | 涉及用例数 | 涉及文件数 | 处置建议 |
|---|---|---|---|
| **C. 已失效 / 恒真 / 无效守卫** | 9 | 6 | 优先修复或删除 |
| **A. 重复验证相同逻辑** | 约 22 | 11 | 合并或删除 |
| **B. 覆盖范围重叠** | 约 14 | 10 | 视分层价值决定 |
| **结构性重复（helper 重复造轮子）** | 3 处 | 4 | 抽公共 helper |

**关键发现：不存在"完全同名"的重复用例**（已用工具比对全部用例名，无一重名）。冗余全部表现为**跨文件的语义重复**与**已失效断言**，因此需要按业务域逐条判定，无法用文件名去重。

另一个总体性事实：**5 个 `stage*-database-integration.test.js` 默认全部 `skip`**（`RUN_DATABASE_INTEGRATION !== "1"`）。这直接导致其中 3 个文件的失效问题长期未被 CI 暴露——它们不是"冗余"，而是"僵尸测试"。

---

## 二、C 类：已失效 / 恒真 / 无效守卫（最高优先级）

### C1. `server/test/stage5-database-integration.test.js` — 构造签名已失配 ★已复核

- **用例**：`stage 5 real database flow: package snapshot, tamper rejection, verified grant and duplicate callback`
- **位置**：L64 `new PostgresPaymentService(pool, gateway, config.auth.openidHashSecret, () => now)` — 传 **4 个参数**
- **实际源码**：`server/src/modules/payments/payment-service.ts:89-97` 现为 **7 参**
  `(pool, virtualPay, legacyPay, openidEncryptionSecret, now, reconcileOptions, newUserPackageGateEnabled)`
- **后果**：参数整体错位——`gateway` 被当作 `virtualPay`、`openidHashSecret` 被当作 `legacyPay`、`now` 被当作 `openidEncryptionSecret`。一旦开启集成环境变量运行即崩溃。
- **建议**：**重写**。改为显式传 `virtualPay` / `legacyPay` 两个桩，或直接删除（其业务覆盖已被 `payment-orders.test.js` 等单测完整接管）。

### C2. `server/test/stage3-database-integration.test.js` — INSERT 缺必填列 ★已复核

- **用例**：`stage 3 real database flow: idempotency, cancellation, ownership and favorite pagination`
- **位置**：L45-52 裸 `INSERT INTO pindou_works (...)` 未给 `generation_mode`
- **实际源码**：`server/sql/010_generation_mode.sql:5-7` 先 `ADD COLUMN ... NOT NULL DEFAULT 'standard'`，紧接着 `ALTER COLUMN generation_mode DROP DEFAULT`
- **后果**：迁移落地后该列**无默认值且 NOT NULL**，此 INSERT 必报空值约束错误。
- **建议**：补 `generation_mode` 列值，或改走 `PostgresWorkService` 建数据（更推荐，可兼得 C7 的精简）。

### C3. `server/test/stage4-database-integration.test.js` — 同上 ★已复核

- **用例**：`stage 4 real database flow: grants, purchased quota, concurrency, insufficiency, idempotency and ownership`
- **位置**：L43-49 同样的 INSERT 缺 `generation_mode`
- **建议**：同 C2。

### C4. `server/test/orders-http.test.js` — 恒真断言 ★已复核

- **用例**：`empty order list is returned without loading package configuration`
- **位置**：L163 `assert.equal(calls.some((call) => call.sql.includes("pindou_packages")), false)`
- **实际源码**：`payment-service.ts:115-151` 的 `listOrders` 三条 SQL **全部只查 `pindou_orders`**，从不触碰 `pindou_packages`
- **后果**：断言恒为真，删掉该行测试依然通过，属于**假保护**。
- **建议**：删除该断言；若想保留"不加载套餐配置"的意图，改为断言 `listOrders` 不调用 `getPackages`（用桩计数）。

### C5. `server/test/orders-http.test.js` — 无效守卫 ★已复核

- **用例**：`reading expired orders never calls payment reconciliation or the gateway`
- **位置**：L176 `service.reconcilePendingOrders = () => { throw new Error("GET must not reconcile"); }`
- **实际源码**：`listOrders` 从不调用 `reconcilePendingOrders`；真正被调用的是私有方法 `reconcileExpiredOrders`（`payment-service.ts:153`），且仅在 `createPayment` 中触发
- **后果**：被覆写的方法永不被调用，守卫形同虚设，测试通过不代表约束成立。
- **建议**：删除该守卫，或改为断言"读列表不写库 / 不产生 UPDATE"。

### C6. `server/test/wechat-pay-client.test.js` — 测试死代码路径 ★已复核

- **用例**：`official JSAPI order call verifies WeChat response and returns only client-safe payment fields`
- **位置**：L101-127，测 `wechat-pay-client.ts:205` 的 `createPayment`
- **实际源码**：全 `src` 范围内 `legacyPay` **仅有一处使用** —— `payment-settlement.ts:727` 的 `this.legacyPay.verifyNotification(input)`。`createPayment`（JSAPI 下单）**零调用点**；下单实际走 virtualPay。
- **建议**：与负责人确认旧通道 JSAPI 下单是否已废弃。若已废弃 → 连 `wechat-pay-client.ts` 的 `createPayment` 及本用例一并删除；若作为"未来可恢复能力"保留 → 在用例旁加注释说明这是**回归保护而非当前路径**，避免后人误判。

### C7. `server/test/toapis-image-provider.test.js` — 整文件覆盖生产不可达分支 ★已复核

- **涉及**：该文件**全部 8 个用例**
- **实际源码**：`src/index.ts:90` 中 `new ToapisImageProvider({ enabled: false })` —— **恒禁用**
- **连带**：`ai-generation-service.test.js` 中依赖 ToAPIs 轮询的用例（`ToAPIs tasks are polled asynchronously…`、`GET AI task is read-only…`、`background scan resumes persisted tasks…`）同样只覆盖走不到的轮询分支
- **建议**：确认不再启用 ToAPIs → 整文件删除，轮询类用例改用 mock provider（用例内不绑定 `toapis` 具体名称，保留状态机覆盖价值）。

### C8. `server/test/qq-link-schema-migration.test.js` — 自证式空壳测试 ★已复核

- **用例**：`QQ link challenge migration documents every column required by schema inspection`（该文件仅 12 行）
- **内容**：读取自身 `sql/025_qq_link_challenge_column_comments.sql`，正则断言 5 个列有 `COMMENT ON COLUMN`
- **问题**：迁移已落地；测试**既不校验真实数据库，也不校验 `schema-contract.ts`**，只是"断言自己写的 SQL 文件里写了注释"，无任何回归价值
- **建议**：**删除**；或改造为断言 `schema-contract.ts` 中 `pindou_qq_link_challenges` 的列名集合 ⊆ 迁移注释集合（这样才真正防漂移）。

### C9. `server/test/auth.test.js` — 断言的是测试自带 fake，非真实代码 ★已复核

- **用例**：`QQ identity links to the authenticated WeChat user once and rejects an identity owned by another account`
- **位置**：L187-193 断言 `QQ_IDENTITY_CONFLICT`
- **问题**：该错误由本文件 **L54-56 自建的 `InMemoryAuthRepository`** 抛出，不经过任何真实实现；真实分支（`auth-repository.ts:191-193`）已被 `auth-repository.test.js` 的 `QQ identity conflict aborts linking without creating a session or consuming the code` 用 SQL 级断言覆盖
- **建议**：删除 auth.test.js 的 L187-193；同用例的 `QQ_LINK_CODE_INVALID` 段（L182-185）同样只走 fake，建议下移到 `auth-repository.test.js`（真实仓库该分支目前反而无覆盖）。

---

## 三、A 类：重复验证相同逻辑

> 标记 ★ 表示已由我回查源码确认；未标记的来自分组深度分析，附行号依据。

### A1. 支付域（重灾区，5 个文件互相重叠）

| # | 文件 / 用例 | 冗余原因 | 建议 |
|---|---|---|---|
| A1-1 | `payment-orders.test.js` → `same-key retry reports a closed order as expired…` | 完全被 `payment-order-actions.test.js:142-149` 覆盖，且后者更强（多断言 `queryCallCount()===0`） | **删除** |
| A1-2 | `payment-orders.test.js` → `an expired order confirmed unpaid is closed and requires a new order` | 与 `payment-order-actions.test.js:173-183` 近乎逐行相同 | **合并，删其一** |
| A1-3 | `payment-reconciliation.test.js` → `an unpaid order inside the stale window stays pending without alerting`(L94-107) | ≡ 同文件 `…stays pending without closing`(L202-214)，同一构造，后者仅多两条断言 | **合并为一条** |
| A1-4 | `payment-reconciliation.test.js` → `closing an order only touches rows still pending`(L186-200) | ≡ `a provider-confirmed closed attempt closes the local order`(L167-184)；且 `AND status='pending'` 已在 L141-142 断言过 | **删除 L186-200** |
| A1-5 | `payment-reconciliation.test.js` → `reconcile only scans orders wired to a virtual payment product`(L79-92) | 与 `reconcile retries unknown attempts…`(L62-77) 断言同一条扫描 SQL；且本用例**根本没断言 virtual_product_id 条件**（src 扫描 SQL 也不筛）→ 名不副实 | **合并 + 改名或补断言** |
| A1-6 | `payment-delivery.test.js` → `delivery for a missing order is rejected without a grant`(L97-103) | ≡ `delivery for an unknown merchant trade number…`(L145-153)，同 `/支付订单不存在/` + `inserts===0`，源自 `payment-settlement.ts:492/589` 同一 `notFound` | **合并为参数化用例** |
| A1-7 | `payment-refunds.test.js` → `iOS refund query allows the refund when the order is unknown`(L162-166) | ≡ `…never blocks a refund it cannot attribute`(L168-172)，断言完全相同 | **合并** |
| A1-8 | `payment-refunds.test.js` → `refund locates the order by the merchant trade number…`(L92-108) | applied/clawedBack/updates 三条断言与 L13-30 完全重复，唯一新增是"0 告警" | **精简为只断言 applied + alerts** |

### A2. AI / 生图域

| # | 文件 / 用例 | 冗余原因 | 建议 |
|---|---|---|---|
| A2-1 ★ | `ai-generation-service.test.js` → `AI provider failure enters a failed terminal state…` 与 `provider submission errors fail the task…` | L346 / L421 断言**完全一致**（failed + `AI_SERVICE_BUSY` + saveCount 0 + debitCount 0），仅入参 kind 为 UNKNOWN(422)/UNAVAILABLE(503)，映射同码 | **合并为参数化用例** |
| A2-2 | `ai-generation-service.test.js` → `provider rate limit still fails the task after the attempts are exhausted` 与 `…cooldown grows exponentially with each hit` | L474-498 与 L500-531 跑同一失败路径，后者仅多断言冷却序列 `[8k,16k,32k,60k,60k,60k]` | **合并**，保留冷却断言 |
| A2-3 | `ai-error-contract.test.js` → `导出的内部码清单与实际情况一致且每项可翻译`(L71-77) | 是 `provider / 状态机 / 存储侧的内部码全部能翻译成公开失败`(L59-69) 的**真子集**（都断言 `aiPublicFailure(code)` 非 null） | **合并**，仅保留"清单无重复项"这一独有断言 |
| A2-4 | `works-http.test.js` → `cross-owner work deletion follows the ownership error contract`(L334) 与 `cross-owner favorite access follows the ownership error contract`(L410) | 骨架完全相同（越权 → 403 `FORBIDDEN`） | **合并为一个越权契约用例** |
| A2-5 | `text-image-work-service.test.js` → `failed task deletion checks status and owner before deleting the task or temporary file` | L189 实例化的却是 `PostgresTextImageGenerationService`，**本就不属于该文件被测的 works 服务** | **迁移到 `text-image-generation-service.test.js`** |
| A2-6 | `hunyuan-image-provider.test.js` → `Hunyuan output downloads do not follow redirects or accept non-PNG output` | L201 `redirect:"error"` 断言与 `tokenhub-hunyuan-image-provider.test.js:186` 完全相同 | **合并**，保留一份 |

### A3. 认证 / 隐私 / 存储域

| # | 文件 / 用例 | 冗余原因 | 建议 |
|---|---|---|---|
| A3-1 ★ | `auth.test.js` → `AuthService hashes session tokens before repository revocation and repeats the request` | L295-301 连续调用两次并 `deepEqual([[h,now],[h,now]])`，第二次调用不进入任何新分支（revokeSession 幂等），属自证断言 | 删除重复调用，保留单次哈希断言 |
| A3-2 | `auth-http.test.js` → `GET /api/users/me derives ownership exclusively from Bearer token` | L290 的 `linkedProviders` 断言值由 stub 直接返回，http 层并未计算；同一断言已由 `users.test.js` 用真实 service 覆盖 | 删除 L290，保留 token→userId 归属断言 |
| A3-3 | `privacy-http.test.js` → `privacy endpoints require authentication and reject invalid fields` | 标题声称校验非法字段，L61-64 却只断言 401，无字段校验；真正的字段校验在同文件 L89-101 | **改名**（去掉"reject invalid fields"）或并入下一用例 |
| A3-4 | `content-security-service.test.js` → `risky synchronous image result is blocked…`(L144-156) 与 `develop risky media check is rejected…`(L190-201) | 断言集合近乎相同（`CONTENT_RISKY` + `removed.length===1` + `calls` 仅 `["sync"]`），仅 `asyncMediaCheckEnabled` 开关不同 | **合并为参数化用例** |
| A3-5 | `quota-download-service.test.js` → `palette download records are accepted and mapped as quota-consuming downloads`(L214-234) | 与 `download history filters…`(L189-212) 走同一 `listDownloads`，唯一新增 `fileType==='palette'` 由 `mapDownload` 白名单静态保证 | **合并或删除** |

---

## 四、B 类：覆盖范围重叠（多数建议保留）

> 这一类的共性是 **service 层与 HTTP 层重复覆盖同一校验规则**。分层断言本身有价值（service 验逻辑、http 验错误码映射与脱敏），但纯透传型断言应删。

| # | 重叠点 | 判定 | 建议 |
|---|---|---|---|
| B1 | `payment-orders.test.js`「不接受客户端金额」≡ `payments-http.test.js:64-88` 同规则 | 分层防御，两者都有价值 | **保留双方** |
| B2 | `payments-http.test.js:90-100` 的 409 `ORDER_ALREADY_PAID.details` | 纯透传，service 层已覆盖两次 | **删除该子断言** |
| B3 | `privacy-http.test.js` 的 `dependencies()` stub(L25-32) 自行实现了 `localOnly/cloudSync` 互斥 | 真实规则在 `user-profile-service.ts:287-288`，stub 导致 http 用例**永远触达不到真实逻辑**；该规则已由 `privacy-service.test.js` 覆盖 | **简化 stub** 为 `{...defaults,...patch}` |
| B4 | 「缺失鉴权 → 401」散落三处：`auth-http.test.js:205`、`privacy-http.test.js:62-63`、`privacy-http.test.js:179-180` | 同一条共享契约，后两处连文案都一样 | 保留 auth-http（额外断言 `revoked===0`），privacy 两处只留各自独有断言 |
| B5 ★ | `works-http.test.js` 越权 ≡ `works-service.test.js` → `user A cannot read, delete or bind user B resources` | HTTP 只验错误映射，service 才是事实来源 | **保留双方**（分层） |
| B6 | `content-security-http.test.js:37` ≡ `content-security-service.test.js:151` 硬编码同一文案 | 文案重复硬编码，改动需同步两处 | http 保留契约断言，service 改断言 `error.code` |
| B7 | `downloads-http.test.js`(L72/L99) ≡ `stage4`(L165) ≡ `quota-download-service.test.js`(L189)：`fileUrl === undefined` | 三处重复 | **http 层保留，其余两处删** |
| B8 | `avatar-storage.test.js:31-42` ≡ `cover-storage.test.js:11-16`（真实格式/MIME 一致性校验） | src 是两份**独立实现**（`avatar-storage.ts:83` vs `image-validation.ts:15`），非同一份代码 | 保留两份；若计划合并 src 实现再合并测试 |
| B9 | `dependency-tslib-license.test.js:37` 弱重叠 `cloudfunction-dependency-lock.test.js:60` | 前者额外断言 license **值** `0BSD` 与 version，后者只查存在性 | **保留** |

---

## 五、结构性重复（helper 重复造轮子）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| S1 ★ | `quota-download-service.test.js:7-28` 自建 `clientPool` | 与 `payment-test-helpers.js:17-36` 几乎逐行相同（仅 `release`/`connectCount` 差异） | 抽到公共 helper |
| S2 | `orders-http.test.js:84-96` 亦自建 pool 桩 | 同上 | 同上 |
| S3 ★ | `payment-test-helpers.js:578` 导出 `ENCRYPTED_OPENID`、`ENCRYPTED_SESSION_KEY`；`:29-30` 导出 `connectCount` getter | 全 test 目录**零消费者**（文件内部自用，导出多余） | 从 `module.exports` 中移除 |
| S4 | `stage2~stage6` 五文件脚手架同构 | `loadLocalEnv/readConfig/createPool/randomBytes 后缀/try-finally 清理 + skip: !enabled` 逐字重复；stage3 L27-54 与 stage4 L26-50 的 fixture SQL 近乎重复 | 抽公共 fixture helper；**业务域不同，用例不要删** |
| S5 | `dependency-axios-maxbodylength-http2.test.js` + `dependency-axios-fetch-max-body-length.test.js` | 守护同一不变量「maxBodyLength 对未知大小的流式请求体生效」，只是 http2 / fetch 两条适配器分支 | **合并为 `dependency-axios-maxbodylength.test.js`（2 用例）** |

---

## 六、未发现冗余的文件（共 21 个，无需处理）

`ai-file-storage.test.js`、`ai-http.test.js`、`ai-prompt-template.test.js`、`auth-repository.test.js`、`cloudfunction-dependency-lock.test.js`、`dependency-axios-noproxy.test.js`、`dependency-axios-formdata-depth.test.js`、`dependency-axios-version.test.js`、`favorites-service.test.js`（内部无冗余，但与 stage3 重叠，见下）、`file-assets.test.js`、`health.test.js`、`pattern.test.js`、`schema-inspector.test.js`、`share-links-http.test.js`、`text-inspiration-cloudfunction.test.js`、`users.test.js`、`wechat-client.test.js`、`qq-client.test.js`、`wechat-url-link-client.test.js`、`virtual-pay-client.test.js`、`virtual-pay-push.test.js`、`content-security-client.test.js`

> `content-security` 三件套（client / service / http）分层清晰：client 验适配、service 验业务+持久化、http 验路由，**除 B6 外无实质重复**。
> `dependency-*` 组经实测确认：axios 唯一副本为 `server/node_modules/axios@1.20.0`，5 个测试分别是「lock 静态门禁」+「4 个运行时行为门禁」，属刻意分层，**非冗余**，全部断言在 1.20.0 中均真实成立，无假阳性。

---

## 七、处置优先级

### P0 — 立即处理（测试在说谎）✅ 已执行

> 执行时间：2026-10-17 ｜ 全量回归：`314 tests / 310 pass / 0 fail / 4 skipped`（原先 5 个 skip，删除 stage5 后剩 stage2/3/4/6）

1. **C1** stage5 构造签名失配 → ✅ **已删除** `server/test/stage5-database-integration.test.js`
   - 选择删除而非重写的原因：`createPayment` 现依赖 `virtual_product_id`、用户 `session_key_ciphertext` 与 `virtual_out_trade_no`，重写后无法在本地验证（需真实库），交付一个"看起来对但没跑过"的集成测试比删掉更糟。其业务覆盖已由 `payment-orders.test.js`（13 用例）完整接管。
   - 回滚：`git checkout HEAD -- server/test/stage5-database-integration.test.js`
2. **C4 / C5** orders-http 恒真断言 + 无效守卫 → ✅ **已修正**
   - 删除恒真断言 `calls.some(sql.includes("pindou_packages")) === false`，替换为真实断言「分页窗口下推到 SQL」（`LIMIT 5 OFFSET 10`），并去掉名不副实的标题
   - 删除无效守卫 `service.reconcilePendingOrders = () => { throw ... }`，改名并补上「过期订单仍原样返回、路径只读」的真实断言
3. **C8** qq-link-schema-migration 自证空壳 → ✅ **已删除**
   - 回滚：`git checkout HEAD -- server/test/qq-link-schema-migration.test.js`
   - 若日后想恢复守护，应改写为断言 `schema-contract.ts` 列名集合 ⊆ 迁移注释集合
4. **C9** auth.test.js 断言 fake 而非真实代码 → ✅ **已删除并迁移**
   - 移除 `QQ_IDENTITY_CONFLICT` 段（真实分支已由 `auth-repository.test.js` 覆盖）
   - `QQ_LINK_CODE_INVALID` 段不直接丢弃（真实仓库当时无覆盖），已**迁移**为 `auth-repository.test.js` 新增用例 `an unknown or already-consumed link code aborts linking before touching the user`，用 SQL 级断言验证：抛错码、未 UPDATE 用户、未建 session、以 ROLLBACK 收尾
   - 用例更名为 `QQ identity links to the authenticated WeChat user`，并加注释说明为何不在此处断言拒绝分支

### P1 — 与负责人确认后处置（涉及死代码）
5. **C6** wechat `createPayment` 无调用点 → 确认废弃则删代码+删测试
6. **C7** ToAPIs 恒 `enabled:false` → 确认废弃则删整文件（8 用例）+ 改造轮询用例

### P2 — 直接合并（纯重复，无争议）
7. A1-1 ~ A1-8（支付域 8 条）
8. A2-1 ~ A2-6（AI 域 6 条）
9. A3-1 ~ A3-5（3 条）
10. S5 axios http2/fetch 合并

### P3 — 清理与加固
11. **C2 / C3** stage3/4 补 `generation_mode` 或改走 service
12. **S1~S4** helper 去重、移除死导出
13. **B 类** 逐条裁掉纯透传断言，保留分层防御

### P4 — 建议补一个门禁
5 个 stage 测试默认 `skip`，建议：**要么在 CI 中开启 `RUN_DATABASE_INTEGRATION=1` 让它们真正生效，要么删除**。当前"写了但永不运行且已失配"是最差状态——既无人维护，又给人虚假的安全感。

---

## 八、附带发现的**覆盖缺口**（非冗余，但值得记）

- `schema-contract.ts:410` 的 `pindou_text_image_works` 提示词长度 CHECK 约束**无任何用例覆盖**
- 云函数侧的 `axios 1.20.0` **无版本断言**（`dependency-axios-version.test.js` 只覆盖 server lock）
- `dependency-tslib-license.test.js` 硬编码 `generateImage`，新增云函数不会被覆盖
- `dependency-axios-version.test.js` 用精确等于 `"1.20.0"`，升级 axios 即红——建议改为 `>=` 语义

---

*报告生成：2026-10-16 | 基于 310 个用例的全量静态分析与源码回查*
