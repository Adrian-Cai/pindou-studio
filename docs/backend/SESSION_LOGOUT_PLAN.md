# 会话登出（服务端令牌失效）开发方案

> 状态：**已按评审意见修订**（共 5 处订正 + 2 项新增，文中「修订」「新增」小节逐条标出改变了什么、为什么）
> 对应问题：登录流程审核 P1 ——「没有服务端登出，token 签发后 30 天内不可失效」
> 涉及端：`server/`、`miniprogram/`
> 预估改动：服务端 4 个文件、客户端 3 个文件、新增 1 个测试域，**零数据库迁移**
> 划分：PR1 服务端闭环 / PR2 客户端；「退出所有设备」UI 入口为第二阶段，其余均第一阶段

---

## 1. 问题陈述

`pindou_auth_sessions` 支持 `revoked_at` 软失效（注销账号在用：`user-profile-service.ts:367-372`），
但**没有任何端点能让用户主动吊销自己的会话**。

```ts
// miniprogram/store/auth-store.ts:311-315  现状：只动本地
async logout(): Promise<void> {
  await appStore.leaveAccount()
  clearAuthSession()               // ← 服务端会话完好无损
  this.setState({ ...initialState })
}
```

后果：token TTL 30 天（`AUTH_TOKEN_TTL_DAYS` 默认 30），期间任何持有该 token 的人可继续调用
全部需鉴权接口，包括 `POST /api/payments/create` 与 `POST /api/ai/generations`（扣额度）。
用户「点了退出登录」在服务端眼里等于什么都没发生。

### 一个必须提前明确的残余风险

**单令牌登出无法止损已泄漏的 token。** 用户点「退出登录」时只能吊销自己手上这一份；
攻击者手上那份仍在有效期内。因此本方案把「登出所有设备」列为**必做项而非可选项** ——
只有它才是真正的止损手段。仅实现单会话登出的话，P1 只修了一半。

阶段划分见 §6.4：第一阶段交付 API 与 `authStore.revokeAllDevices()`，
**能力完整可用**（可 curl 调用）；第二阶段才补图形入口。

---

## 2. 目标 / 非目标

**目标**

1. 提供 `DELETE /api/auth/session`：吊销当前 token 对应的会话。
2. 提供 `DELETE /api/auth/sessions`：吊销当前用户的所有会话（多设备止损）。
3. 登出须在**服务端立即生效**，后续请求拿不到 200。
4. 服务端调用失败（网络/未部署）时，**本地登出必须仍然完成**，不得回滚 UI。

**非目标**（明确不在本次改动内，避免范围膨胀）

- 会话有效期缩短 / 滑动续期 / refresh token。（`last_used_at` 恒为 NULL 是既有缺陷，另行处理）
- 过期会话的定期清理任务。（新增 revoke 会让行数更多，需单独立项）
- `wx.checkSession` 补齐、登录接口限流、会话表基表建表脚本 —— 同为审核发现项，各自单独方案。

---

## 3. 现状核对（作为设计前提的代码事实）

| 事实 | 位置 | 对设计的约束 |
|---|---|---|
| 已存在 `revoked_at` 列，nullable，authenticator 已判定 | `authenticator.ts:21` | **零迁移**，沿用软失效 |
| 唯一索引在 `token_hash`、`user_id` 上有索引 | `schema-contract.ts:194-197` | 两条吊销语句都有索引支撑 |
| 已有 revoke 语句范式 | `UPDATE ... SET revoked_at = COALESCE(revoked_at, $2)` | 复用同一范式，幂等天然成立 |
| 依赖容器只有一个 `auth` 口子 | `index.ts:134` | 扩方法则不改装配 |
| 路由惯例：pathname 精确匹配 + `searchParams.size > 0 → 400` | `app.ts:980-1030` | 新路由必须沿用，含对应测试 |
| 客户端 `logout()` 也被 `deleteAccount()` 调用 | `auth-store.ts:303` | 注销后再次登出会撞 401，需显式跳过 |

---

## 4. 接口设计

```
DELETE /api/auth/session     吊销当前 token 对应的会话
DELETE /api/auth/sessions    吊销当前用户的所有会话（含当前设备）
```

### 4.1 响应契约（修订）

> 初稿写「重复调用返回 204」是错的。路由先走鉴权器，而 `authenticator.ts:21-24` 明确拒绝
> `revokedAt` 非空与已过期的会话，第二次请求根本到不了 SQL。以下为订正后的契约。

| 情形 | 响应 |
|---|---|
| 首次调用，会话有效 | `204 No Content` |
| 再次调用（已吊销） | `401 UNAUTHORIZED` "登录状态已失效" |
| 调用时已过期 | `401 TOKEN_EXPIRED` |
| 调用时用户已注销 | `401 UNAUTHORIZED`（`userDeletedAt` 分支） |

即：**HTTP 层面不幂等，`revokeSession` 的 SQL 层面幂等**。
区分二者不是为了咬文嚼字 —— 客户端必须据此把 401 当作「登出已达成」而非「登出失败」，
否则用户第二次点退出登录会看到一个莫名其妙的错误提示。

补充：`/api/auth/sessions` 会把**当前设备**的会话一起吊销，因此它成功后客户端必须立即本地登出，
否则本地 token 已成僵尸，下一次请求才会 401（多一次无谓往返才进 `expired` 态）。

### 4.2 请求约束

- 不接受 query：沿用现有惯例 `url.searchParams.size > 0 → 400`，**在鉴权之前**拒绝。
- 不接受 body：明确拒绝非空请求体，见 §5.5。
- 身份只从 `Bearer token` 推导，不存在任何客户端可控的 `userId` 入参。

> 为什么不用 `POST /api/auth/logout`：`DELETE` 资源语义，且与既有 `DELETE /api/users/me`
> （注销）保持一致，客户端一眼能看出「这是资源销毁操作」。

---

## 5. 服务端改动

### 5.1 定位会话：让吊销接受 token 原文（修订）

> 初稿的方案是给 `AuthenticatedUser` 增加 `tokenHash` 字段。评审指出两点不成立：一是那个
> 「泄漏」的说法被夸大了（`tokenHash` 既不能当 Bearer 用，也不能单独调吊销，后者仍需鉴权）；
> 二是对应的守卫测试挂在一个测不到的地方 —— `GET /api/users/me` 返回的是用户服务的输出，
> 压根不经过鉴权结果对象。
>
> 与其用一条测不到位的测试去守一个说不清的风险，不如换个不需要守的设计。

**改让 `revokeSession` 接受 token 原文，由服务层内部哈希。** 路由手上本来就有
`request.headers.authorization`，不存在需要往鉴权结果里塞东西的理由。

```ts
// modules/auth/auth-service.ts
public async revokeSession(token: string): Promise<void> {
  await this.repository.revokeSession(hashToken(token), this.now());
}
```

由此得到三个收益，同时消掉初稿的三处成本：

- `modules/auth/types.ts` 与 `authenticator.ts` **完全不用改**；
- `server/test/auth.test.js:123` 的 `deepEqual(..., { id: "usr_test" })` **不会被打破**；
- 不存在「内部字段被误序列化」的面，§8 里那条相关的守卫测试随之删除。

需要一个从 header 取原文的 helper（`authenticator.ts:17` 已有一个正则，把取捕获组的部分抽出来共用，
避免两处正则漂移）：

```ts
export function parseBearerToken(authorization: string | undefined): string | null {
  return authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,512})$/)?.[1] ?? null;
}
```

### 5.2 `modules/auth/auth-repository.ts` —— 两个吊销方法

```ts
/** 吊销单个会话；幂等：已吊销或不存在也算成功（目标状态已达成）。 */
async revokeSession(tokenHash: string, now: Date): Promise<void> {
  await this.pool.query(
    `UPDATE pindou_auth_sessions
        SET revoked_at = COALESCE(revoked_at, $2)
      WHERE token_hash = $1`,
    [tokenHash, now],
  );
}

/** 吊销该用户的所有会话（设备丢失 / token 泄漏的止损手段）。 */
async revokeUserSessions(userId: string, now: Date): Promise<void> {
  await this.pool.query(
    `UPDATE pindou_auth_sessions
        SET revoked_at = COALESCE(revoked_at, $2)
      WHERE user_id = $1`,
    [userId, now],
  );
}
```

单条语句、无需事务（无跨表一致性要求）。返回值行数刻意不区分 —— 区分等于向调用方泄漏
「这个 token 是否存在」的信息。

> **一致性收尾（可选，本期建议做）**：`user-profile-service.ts:367-372` 的注销 revoke 是同一段
> SQL 的内联副本。注销与本方案应共享同一个实现来源，否则将来改 one 会漏 another。
> 抽到 `AuthRepository` 后由 `deleteAccount` 调用即可，改动很小。
> 若担心扩大改动面，可本期不动，但需在 PR 描述里记一笔。

### 5.3 `modules/auth/auth-service.ts` —— 扩展现有依赖接口（修订）

> 初稿提议把类 `AuthService` 改名为 `DefaultAuthService`，理由是项目有
> `PostgresAuthRepository` / `BearerTokenAuthenticator` 的前缀命名习惯。
> 评审指出这是纯粹的命名整理。认同 —— 命名一致性不是这次要解决的问题，
> 为一个无关的好处扩大改动面不值得。**接口直接扩展，不重命名。**

```ts
// 保留现有类名 AuthService 与接口名 AuthLoginService，只加两个方法
export interface AuthLoginService {
  login(code: string): Promise<LoginResult>;
  /** token 原文 → 内部哈希后吊销；已吊销/不存在均视为达成目标。 */
  revokeSession(token: string): Promise<void>;
  revokeUserSessions(userId: string): Promise<void>;
}
```

`index.ts:134-138` 的装配行**一行都不用动**。

### 5.4 `http/app.ts` —— 两个路由（含 body 拒绝）

```ts
if (request.method === "DELETE" && url.pathname === "/api/auth/session") {
  if (url.searchParams.size > 0) throw invalidArgument("登出接口不接受查询参数");
  if (hasRequestBody(request)) throw invalidArgument("登出接口不接受请求体");
  await dependencies.authenticator.authenticate(request.headers.authorization);
  const token = parseBearerToken(request.headers.authorization);
  if (!token) throw unauthorized();                       // 鉴权已过，此处仅为类型收窄
  await dependencies.auth.revokeSession(token);
  sendNoContent(response);
  return;
}

if (request.method === "DELETE" && url.pathname === "/api/auth/sessions") {
  if (url.searchParams.size > 0) throw invalidArgument("登出接口不接受查询参数");
  if (hasRequestBody(request)) throw invalidArgument("登出接口不接受请求体");
  const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
  await dependencies.auth.revokeUserSessions(currentUser.id);
  sendNoContent(response);
  return;
}
```

**为什么不能直接用 `readJsonObject` 实现「拒绝 body」**（实施时容易踩）：
`request-body.ts:24-27` 在 `content-type` 不是 `application/json` 时抛 **415**，且空 body 会在
`JSON.parse('')` 处抛 `invalidArgument`。正常登出请求不携带 body，直接调用它会让**每一个正常
请求都变成 415**。因此这里用纯 header 判断，不读流：

```ts
function hasRequestBody(request: IncomingMessage): boolean {
  const length = request.headers["content-length"];
  if (length !== undefined) return Number.parseInt(length, 10) > 0;
  return request.headers["transfer-encoding"] !== undefined;
}
```

两点说明：

- 两个路由的操作都是「先鉴权、再吊销」，鉴权器的 `revokedAt` / `expiresAt` / `userDeletedAt`
  三个分支就是 §4.1 那张表的来源，无需重复实现。
- pathname 是精确匹配，`/api/auth/session` 与 `/api/auth/sessions` 互不前缀，顺序无影响。

---

## 6. 客户端改动

### 6.1 `services/auth-service.ts`

```ts
/** 吊销当前会话（退出登录）。 */
export async function revokeCurrentSession(token: string): Promise<void> {
  await apiRequest<unknown>({ path: '/api/auth/session', method: 'DELETE', token })
}

/** 吊销该账号在所有设备的会话（设备丢失 / 疑似泄漏时止损）。 */
export async function revokeAllSessions(token: string): Promise<void> {
  await apiRequest<unknown>({ path: '/api/auth/sessions', method: 'DELETE', token })
}
```

### 6.2 `store/auth-store.ts` —— 登出时序（本方案的核心决策）

**决策：先本地清，再尽力调服务端，失败不回滚。** 但「先本地」要分两步走，见 6.2.1。

#### 6.2.1 凭证清除必须排在本地持久化之前（修订）

> 初稿直接 `await appStore.leaveAccount()`，而它在 `persist()` 之后才返回
> （`app-store.ts:92-94`）。本地持久化可能抛 `LocalStorageError`（配额写满），
> 一旦抛出，`clearAuthSession()` 与 `setState` 都不会执行 —— 用户点了退出登录却被提示失败，
> 且**凭证还在本地**。这比网络失败更严重：它是每次都会复现的确定性失败。

明确行为：**凭证清除属于最高优先级，不受本地数据落盘结果影响。**

```ts
async logout(options: { readonly remote?: boolean } = {}): Promise<void> {
  const session = loadAuthSession()
  const token = session && !isAuthSessionExpired(session) ? session.token : null

  this.bumpAuthVersion()                          // ① 先让在途的恢复流程作废（见 6.2.2）
  clearAuthSession()                              // ② 凭证优先清除，不依赖任何 await
  clearSecuritySession()                          // ③ 见 6.3
  this.setState({ ...initialState })              //    本地 UI 立刻登出

  try {
    await appStore.leaveAccount()                 // ④ 本地数据清理：失败不影响已登出的事实
  } catch (error) {
    console.error('本地数据清理失败，登录凭证已清除', error)
  }

  if (!token || options.remote === false) return
  try {
    await revokeCurrentSession(token)
  } catch (error) {
    // 401（UNAUTHORIZED / TOKEN_EXPIRED）表示会话在服务端本就失效 —— 目标已达成，不算失败。
    if (!isUnauthorized(error)) console.error('服务端会话吊销失败', error)
  }
}
```

为什么这么排：

- **不能被网络绑住**：若先调服务端且超时，用户点了退出却还登着，是最糟的结果。
- **不能被本地磁盘绑住**：同理，本地持久化失败不该阻塞登出。
- 顺序上「凭证 → UI → 本地数据 → 服务端」逐层降级，每层失败都不回滚上一层已完成的动作。
  服务端失败的代价是「token 继续有效到过期」，**等同于今天的行为**，不会比现状更差。

#### 6.2.2 登录态版本号：防止在途请求把登出「撤销」（新增）

> 未被初稿覆盖的竞态。`activateSession()`（`auth-store.ts:394-415`）结构如下：
>
> ```ts
> const profile = await fetchCurrentUser(session.token)   // await 期间用户点了登出
> saveAuthSession({ ...session, user, profile })          // ← 把刚清除的凭证又写回 storage
> this.setState({ status: 'authenticated', ... })         // ← UI 被改回已登录
> ```
>
> `refresh()`（:128）、`performRestore()`（:373）、`restoreAccountData()`（:446）同型。
> 用户在这些请求进行中登出，迟到的成功响应会把状态写回已登录 —— 用户眼看着自己没退出成功。

用递增版本号让在途流程作废，而不是逐个分支去补判断：

```ts
private authVersion = 0

/** 登出 / 过期时调用：此后所有在途流程的写回全部作废。 */
private bumpAuthVersion(): void { this.authVersion += 1 }
private isCurrentVersion(version: number): boolean { return this.authVersion === version }
```

在每个异步写回点前校验：

```ts
private async activateSession(session: AuthSession): Promise<void> {
  const version = this.authVersion
  try {
    const profile = await fetchCurrentUser(session.token)
    if (!this.isCurrentVersion(version)) return      // 中途已登出，丢弃结果
    saveAuthSession({ ...session, user: profile.user, profile })
    this.setState({ ... })
    await this.restoreAccountData(profile.user.id, version)
    if (!this.isCurrentVersion(version)) return      // 同上
    this.setState({ ...this.state, status: 'authenticated', ... })
  } catch (error) { ... }
}
```

`restoreAccountData` 内部也有多处 `await`（`appStore.adoptGuestWorks`、`replaceCloudWorks`、
`syncPendingWorks`），因此版本号要作为参数往下传，在每个写回前校验。

`expireSession()` 同样需要 `bumpAuthVersion()` —— 它也废弃了当前凭证。

#### 6.2.3 全设备吊销

```ts
/** 吊销所有设备会话；服务端会连当前设备一起吊销，因此成功后必须本地登出。 */
async revokeAllDevices(): Promise<void> {
  const session = loadAuthSession()
  if (!session) return
  await revokeAllSessions(session.token)   // 失败照常抛出：调用方需让用户知道止损没成功
  await this.logout({ remote: false })     // 已全部吊销，无需再单独吊销当前会话
}
```

这里与 6.2.1 的策略**刻意不同**：

- 登出是「用户已经达成目的」，失败降级无害 → 静默。
- 全设备吊销是「用户想止损」，成功了会立刻被踢下线；**失败了必须让用户知道**（否则他以为安全了），
  所以异常照抛、UI 需提示。

`deleteAccount()`（302-303 行）改为 `await this.logout({ remote: false })`：账号注销在服务端
已经吊销了全部会话，再单吊销一次只是多发一个必然 401 的请求。

### 6.3 `services/session-service.ts` —— 补上缓存清理（顺带）

这是审核问题 2 的一部分，不清理的话本方案会有残余：模块级 `securitySession` 在登出后仍在内存，
内容安全 / AI 生成两个调用方还会拿着旧 token 发请求。

```ts
export function clearSecuritySession(): void {
  securitySession = null
}
```

由 `auth-store.logout()` 与 `expireSession()` 各调一次。改动一行，属于这次顺手做掉的合理范围。

### 6.4 UI 入口（纳入阶段划分）

> 初稿把「退出所有设备」标为必做，却在任务表里把 UI 延后，第一阶段也没有对应的 store 方法，
> 手动验证却假设用户能点得到。承诺与拆解不一致，此处订正。

| 入口 | 阶段 | 说明 |
|---|---|---|
| 「退出登录」按钮（`packages/account/index.ts:97`） | 第一阶段 | **改动零行**，行为由 store 变更自然获得 |
| `authStore.revokeAllDevices()` | 第一阶段 | store 方法在第一阶段落地（§6.2.3），不依赖 UI 存在 |
| 「退出所有设备」菜单项 | **第二阶段** | 位置待 UI 确认，建议 `packages/account/settings/index` 下「账号与安全」分组，二次确认后调用 |

第一阶段结束时，「退出所有设备」是**能力已上线、UI 未暴露**的状态：API 可用、store 方法可用、
停机止损能力已具备，只是还没有图形入口。第二阶段的 UI 只是把这个已存在的能力摆出来。

因此手动验证清单里涉及该能力的操作改用 **curl 直接调用** 验证，不再假设 UI 已存在。

---

## 7. 兼容性与发布顺序

**发布顺序：必须先后端，后小程序。**

| 场景 | 结果 |
|---|---|
| 新后端 + 旧小程序 | 旧端不调用新端点，无影响 ✅ |
| 旧后端 + 新小程序 | `DELETE /api/auth/session` → 404，被 logout 的 try/catch 兜住，本地照常登出 ✅ |

也就是说：小程序可以先合入，只要后端还没上，行为就退化回今天的样子，不会 regression。
**但止损能力要等后端上线才真正生效。**

小程序有审核周期，建议顺序：合入 → 部署后端 → 验证 → 再提审小程序。

**旧客户端兼容**：`dependencies.auth` 的 fake（`auth-http.test.js:15`）缺新方法在 JS 测试里不会
报错（只有实际调用到才炸），因此现有测试无需批量补方法，只需在新端点的用例里提供实现。

---

## 8. 测试计划

### 服务端单测（`server/test/auth-http.test.js` 扩）

1. `DELETE /api/auth/session` 携带有效 token → 204，且 `revokeSession` 收到的是 **token 原文**
   （断言 `receivedArg === 'opaque_token_...'`；服务层内部哈希，路由不参与哈希计算）。
2. `DELETE /api/auth/sessions` → 204，且 `revokeUserSessions` 收到的是 `currentUser.id`。
3. 无 `Authorization` 头 → 401，且**未进入 revoke**（沿用现有 `unused` throw fake 风格）。
4. 带 query `?userId=usr_attacker` → 400 `INVALID_ARGUMENT`，且鉴权未被调用。
5. **带非空 body → 400 `INVALID_ARGUMENT`**（`content-type: application/json` + `{ "userId": ... }`）。
6. **不带 body 的正常请求不得被 415**：断言无 `content-type` 的请求返回 204。
   这条是 §5.4 里 `readJsonObject` 陷阱的回归守卫 —— 实施时最容易顺手写成「总是读 body」。
7. `revokeSession` 抛错 → 按共享错误契约回传 code 与 `x-request-id`。

### 服务端单测（`server/test/auth.test.js` 扩）

8. `AuthService.revokeSession(token)` 转发到 repository 时**参数是 `hashToken(token)`**，
   不是原文 —— 断言精确到哈希值。
9. `revokeSession` 连续调用两次，repository 两次都被调用（幂等由 SQL 保证，服务层不短路）。

### 集成测试（`server/test/stage2-database-integration.test.js` 扩）

10. **端到端证据最关键**：登录后取 token → `GET /api/users/me` 200 → `DELETE /api/auth/session`
    → 再 `GET /api/users/me` 应 401 `UNAUTHORIZED`。这条证明「服务端真的失效了」，
    只断言 HTTP 204 是不够的。
11. `DELETE /api/auth/sessions` 后同一用户的另一个有效 token 也应 401。
12. **重复登出的契约用例**：同一 token 第二次 `DELETE /api/auth/session` → 401 `UNAUTHORIZED`
    （而非 204）。这条锁住 §4.1 的契约，防止有人以后「为了幂等」把鉴权顺序改掉。

### 客户端测试（新增 `test/auth-store-logout/` 域，参照 `test/ai-failure/` 形态）

> 小程序测试的既有模式：`test/<域>/tsconfig.json` 编译 `miniprogram/**/*.ts`，
> 测试 JS `require` 编译产物；本域需额外 stub `globalThis.wx`（现有域无先例）。

13. **并发恢复回归用例（评审要求，必测）**：
    发起恢复（伪造 `fetchCurrentUser` 返回一个**尚未 resolve** 的 promise）→ 在其等待期间调用
    `logout()` → 再让那个 promise 成功返回 → 断言：
    - storage 中**不存在** token（`loadAuthSession()` 返回 null）；
    - `authStore.getSnapshot().status === 'guest'`；
      这是唯一能稳定复现 6.2.2 竞态的方式，缺了它这条修复就没有证据。
14. **本地持久化失败仍要登出**：令 `appStore.persist` 抛 `LocalStorageError` → `logout()` 不应抛出，
    且 storage 中 token 已被清除、状态为 `guest`。对应 6.2.1。
15. `logout()` 在服务端返回 401 时不视为失败（断言不抛出、不产生 console.error）。
16. `revokeAllDevices()` 成功后本地处于已登出状态；失败时异常照抛（区分 §6.2.3 的两种策略）。

### 手动验证清单

- 退出登录 → 用**同一 token** 在终端 curl 任一鉴权接口 → 预期 401。
- 多设备止损（UI 未上线，用 curl 执行）：A、B 均登录 → 对 B 的 token 调用
  `DELETE /api/auth/sessions` → A 的下一个请求预期 401。
- 飞行模式下退出登录 → 本地仍立即登出，无报错弹窗。
- 退出登录 → 立刻熄屏再进 App（趁本地持久化未落盘）→ 不应回到已登录态。

---

## 9. 需同步更新的文档

| 文件 | 改动 |
|---|---|
| `docs/backend/API_SPEC.md` (`/api/auth/login` 邻近) | 新增两个端点 |
| `docs/backend/openapi.yaml` | 同步（`/api/auth/login` 已有定义，位置 `openapi.yaml:46`） |
| `docs/architecture/CURRENT_ARCHITECTURE.md:91` | 时序图补登出分支 |
| `docs/backend/operations/WECHAT_LOGIN_SETUP.md` | 如有联调步骤需补 |
| `docs/releases/CHANGELOG.md` | 按既有格式追加 |

---

## 10. 任务拆解建议（分两个 PR）

### PR1 —— 服务端能力闭环

| # | 任务 | 阶段 | 依赖 |
|---|---|---|---|
| 1 | `auth-repository.ts`：两个 `revoke*` 方法 | 1 | — |
| 2 | `auth-service.ts`：扩展接口 + `revokeSession(token)` / `revokeUserSessions(userId)` | 1 | 1 |
| 3 | 抽出 `parseBearerToken` helper（与 `authenticator` 共用正则） | 1 | — |
| 4 | `app.ts`：两个路由（含 query / body 拒绝） | 1 | 2, 3 |
| 5 | 服务端 HTTP 层测试（§8 1-7） | 1 | 4 |
| 6 | `auth.test.js` 转发用例（§8 8-9） | 1 | 2 |
| 7 | 集成测试（§8 10-12） | 1 | 4 |
| 8 | 文档同步（§9） | 1 | 4 |

PR1 单独合并不触发任何行为变化（客户端尚未调用），可安全先行部署。

### PR2 —— 客户端（必须等 PR1 上线）

| # | 任务 | 阶段 | 依赖 |
|---|---|---|---|
| 9 | `auth-service.ts`：`revokeCurrentSession` / `revokeAllSessions` | 1 | PR1 已部署 |
| 10 | `auth-store`：登出时序重构（§6.2.1 凭证优先） | 1 | 9 |
| 11 | `auth-store`：登录态版本号（§6.2.2）+ 各写回点校验 | 1 | 10 |
| 12 | `auth-store`：`revokeAllDevices()`（§6.2.3） | 1 | 9 |
| 13 | `session-service`：`clearSecuritySession()`（§6.3） | 1 | — |
| 14 | `test/auth-store-logout/` 新域 + `wx` stub + 用例 13-16 | 1 | 10-12 |
| 15 | 「退出所有设备」UI 入口 | **2** | 12，需 UI 确认 |

第一阶段（PR1 + PR2 全表）结束时，能力与 §1 的承诺一致：
「退出所有设备」可 curl 调用、API 与 store 方法齐备，仅缺图形入口（第 15 项，第二阶段）。

---

## 11. 遗留项（本方案明确不做，留给后续）

- **会话清理任务**：revoke 之后行数只增不减，需要一个按 `expires_at` / `revoked_at` 的定时清理。
- **`last_used_at` 恒为 NULL**：无滑动续期、无法审计活跃度，也就无法对「长期不活跃却仍在用的
  token」做策略。
- **TTL 30 天偏长**：单一静态 token 无 refresh 机制下，30 天泄漏窗口偏大。是否降到 7 天并靠
  静默重登补偿，需要单独评估对用户体验的影响（当前静默重登路径本身也有并发缺陷）。
- **基表建表脚本缺失**：`pindou_users` / `pindou_auth_sessions` 的 `CREATE TABLE` 在
  `server/sql/` 里没有，只存在于 `schema-contract.ts` 的校验契约中 —— 与本次无关，但建议尽快补齐。
