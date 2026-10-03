# 会话缓存统一（消除 `securitySession` 绕过登出）开发方案

> 状态：待评审
> 对应问题：登录流程审核 P1 ——「`session-service.ts` 模块级缓存绕过登出」
> 涉及端：`miniprogram/`（纯客户端改动，不涉及服务端）
> 预估改动：客户端 7 个文件、新增 1 个测试域

---

## 1. 问题陈述

```ts
// miniprogram/services/session-service.ts:8-25  现状
let securitySession: AuthSession | null = null

export async function ensureLoggedInSession(): Promise<AuthSession> {
  const current = loadAuthSession()
  if (current && !isAuthSessionExpired(current)) return current
  if (securitySession && !isAuthSessionExpired(securitySession)) return securitySession  // ← 登出后仍然命中
  ...
  session = await loginWithWechat()
  securitySession = session                                                              // ← 只写内存，不回写 storage
  return session
}
```

三个缺陷：

1. **绕过登出**：`securitySession` 从不清除。用户登出后触发内容安全/AI 生成，第 13 行直接返回旧
   token，且完全不通知 authStore —— UI 显示未登录，请求却带着旧身份成功。
2. **登录结果不回写 storage**：第 23 行只赋模块变量，下次冷启动 `loadAuthSession()` 仍为空，
   再走一次 `wx.login`，白白多一行会话记录。
3. **无并发去重**：并发调用会同时打出多次 `wx.login`，每个都新建一行会话。

附带一个被这个结构放大的现实问题：AI 轮询每 4 秒调用一次 `ensureLoggedInSession`
（`ai-generation-flow.ts:61` `POLL_INTERVAL_MS = 4_000` → `:282` → `getAiGeneration`）。
**token 一旦过期，正在轮询的任务会以每 4 秒一次的频率触发 `wx.login` + 新建会话行**，
这是当前会话表膨胀的一个隐蔽来源。

### 与《会话登出方案》的关系

`docs/backend/SESSION_LOGOUT_PLAN.md` §6.3 里提出的 `clearSecuritySession()` 是**止血措施**。
若采用本方案，那个函数就不需要写了 —— 缓存本体消失，自然无处可清。两者选其一即可，
本方案是彻底版。

---

## 2. 为什么不能直接改成 `await authStore`（核心论证）

直觉上的解法是「让 `ensureLoggedInSession` 统一走 authStore」，但这条路会**自锁**，必须有依据地排除掉。

### 2.1 存在一条从 authStore 到 session-service 的静态依赖链

```
store/auth-store.ts:29          import { syncPendingWorks } from '../services/work-sync-service'
  └─ services/work-sync-service.ts:3   import { checkImageContent } from './content-security-service'
       └─ services/content-security-service.ts:11   import { ensureLoggedInSession } from './session-service'
```

若 `session-service` 反向 import `auth-store`，即为模块环。虽然运行时大概率「良性」（函数体内引用不在
求值期解引用），但打包器与 `import/no-cycle` 会报错，且任何人在顶层加一行 `authStore.xxx` 就会 TDZ 崩溃。

### 2.2 更硬的问题：restore 链路上的**自死锁**

这条静态环的杀伤力在于它是**活的**——`auth-store` 自己就会调用到它：

```
authStore.restore()                    auth-store.ts:97
  → performRestore()                   :373
      → activateSession()              :394
          → restoreAccountData()       :446
              → syncPendingWorks()     :476
                  → checkImageContent()      work-sync-service.ts:26
                      → ensureLoggedInSession()   content-security-service.ts:46
```

此刻 `auth-store.ts:98` 的 `restoreTask` 正处于 **in-flight** 状态。若 `ensureLoggedInSession`
改成 `await authStore.restore()` 或任何"等 store 就绪"的形式：

- `restore()` 第 98 行 `if (this.restoreTask) return this.restoreTask` 返回同一个 promise；
- 嵌套 `await` 它 = **自己等自己，永久挂起**；
- 触发条件很常见：只要此刻 `loadAuthSession()` 为空或已过期（冷启动首登、token 过期后重进）。

`work-sync-service.ts:13` 的 `if (syncTask) return syncTask` 是第二道同型放大器。

**结论**：只要 `restoreAccountData` 内部还会间接触达「确保登录态」，底层服务就**不能反向等待 store**。
这条限制决定了方案形态。

---

## 3. 目标 / 非目标

**目标**

1. 消除任何独立于 authStore 的登录态副本 —— 单份真相。
2. 登出/过期后，内容安全与 AI 生成**不可能**再取到旧 token。
3. 消除并发重复 `wx.login`。
4. 不引入模块环，不引入任何形式的等待 store。

**非目标**

- 服务端改动（本问题纯客户端）。
- AI 轮询的产品逻辑调整（如「未登录时任务卡片怎么显示」）—— 方案只保证**不误判失败**。
- `pindou_auth_sessions` 表清理（见会话登出方案 §11）。

---

## 4. 设计原则：依赖倒置 —— 底层服务不再决定何时登录

`ensureLoggedInSession` 这个抽象本身就是病灶：它把「获取凭据」这件本该由调用方决定的事，
下沉到了不该知道登录态的底层服务里，还顺手给了它**自主发起 `wx.login`** 的权力。

而 AI 生成本来就应该要求用户已登录（它要扣额度），这里的静默重登只是掩盖问题的 workaround。

**修正后的形态**：

| 层 | 职责 |
|---|---|
| 底层服务（内容安全 / AI 生成） | **接受 token 参数**，不再 import 会话模块 |
| 调用方（页面 / flow / 同步链路） | 负责取得 token；取不到时决定 UX（提示登录 / 暂停轮询） |
| 会话模块（重写后） | 提供**同步、无状态**的读取，不持有任何模块级变量 |

底层服务不再决定"现在要不要登录"，谁 RPC 谁负责。

---

## 5. 方案（分三阶段）

### 阶段 A —— 断环（无行为变更，可独立提 PR）

让 restore 链路上已有的 token 显式往下传，`content-security-service` 因此不再需要会话模块，
静态环断开 —— 这是后续一切改动的前提。

```ts
// services/content-security-service.ts
export async function checkTextContent(content: string, token: string): Promise<void>
export async function checkImageContent(
  filePath: string,
  token: string,
  onUploadProgress?: (progress: number) => void,
): Promise<ImageContentCheck>
```

```ts
// services/work-sync-service.ts
export function syncPendingWorks(userId: string, token: string): Promise<WorkSyncResult>
async function performSync(userId: string, token: string): Promise<WorkSyncResult> {
  ...
  await checkImageContent(await prepareImageForContentSecurity(work.coverPath), token)   // :26
}
```

```ts
// store/auth-store.ts
private async restoreAccountData(session: AuthSession, userId: string): Promise<void> {
  ...
  await syncPendingWorks(userId, session.token)     // :476，token 此刻必然有效
}
```

`app.ts:52` 的联网补同步改为先取 token 再调用（取不到就跳过，联网恢复时还会再触发，无需强求）。

**调用点需同步改**：`pages/projects/index.ts:324`、`packages/result/index.ts:299`（文本校验）、
`pages/home/index.ts:188`（选图后图片检测）。

> 阶段 A 单独合并是**零行为变更**的（传的都是之前 `ensureLoggedInSession` 会返回的同一个 token），
> 但它让阶段 B 变得安全。建议单独一个 PR，便于回滚定位。

### 阶段 B —— 重写会话模块（核心修复）

`services/session-service.ts` 整个重写，**删掉模块级变量，删掉异步 `wx.login`**：

```ts
/**
 * 会话读取：同步快照，唯一真相就是 storage。
 *
 * 这里**刻意没有任何模块级状态**：一旦缓存，登出后就必须在每个清缓存的地方都记得清，
 * 漏一处就是「UI 未登录但请求仍带旧 token」。缓存带来的收益（省一次
 * wx.getStorageSync）远不抵这个风险。
 *
 * 也**刻意不做异步**：任何 await 都会让调用方有机会在 authStore 恢复流程内部等待 store，
 * 形成自死锁（见方案 §2.2）。
 */
export function getUsableSession(now = Date.now()): AuthSession | null {
  const session = loadAuthSession()
  return session && !isAuthSessionExpired(session, now) ? session : null
}

/** 拿不到就抛，调用方按需选择「提示登录」或「暂停」。 */
export function requireUsableSession(now = Date.now()): AuthSession {
  const session = getUsableSession(now)
  if (!session) throw new ApiError('登录状态已失效，请重新登录', { code: 'AUTH_REQUIRED' })
  return session
}
```

同步、无状态 → **并发天然安全**（原来的重复 `wx.login` 问题随之消失）；UI 登出即失效；
不再有独立副本需要与 login/logout/expire 三处对齐。

`ensureLoggedInSession` 删除。所有孤立的 import 都得跟着改，编译会一次性揪干净。

### 阶段 B 配套 —— AI 链路显式传 token

```ts
// services/ai-generation-service.ts
export async function uploadAiInput(filePath, token, securityCheckId?, onProgress?)
export async function createAiGeneration(input, token)
export async function getAiGeneration(jobId, token)
```

调用方取 token 的三种情形，见 §6。

---

## 6. 「取不到 token」的语义矩阵（必须先定清楚，否则会漏）

这是本次改造唯一有语义分歧的地方，改造前后对比：

| 场景 | 现状（自动登录） | 改造后 | 理由 |
|---|---|---|---|
| 用户在页面主动操作（发布文本、选图） | 静默登录继续 | **提示请先登录 → 跳 profile** | 用户就在现场，不该替他静默登录 |
| restore 期间的补同步 | 可能触发 `wx.login` | **传 restore 已有的 token** | 此时必然已通过有效性校验 |
| `app.ts:52` 联网补同步 | 可能触发 `wx.login` | **取不到就跳过**（下次联网再试） | 与现有「尽力而为」语义一致 |
| AI 轮询中 token 失效 | 每 4 秒一次 `wx.login` ⚠️ | **暂停轮询，不判失败** | 见下 |

**AI 轮询的降级必须不能误判失败**：token 过期时，任务没有出错，只是暂时查不到。
若抛 `NETWORK_ERROR` 会让任务走失败/重投路径，甚至把已完成的任务判死。

建议形态：`ai-generation-flow.pollOnce()` 检测到无可用 session 时返回一个「等待鉴权」语义，
由 `ai-generation-manager` 的 tick **跳过本次轮询、不推进任务状态**（也不消耗重投次数），
直到用户重新登录后自动恢复。具体信号形式需与 manager 现有错误处理对齐后再定实现细节。

> 这条是整个方案里唯一需要产品确认的点：**token 过期时，进行中的 AI 任务是「暂停等你登录」
> 还是「明确告诉用户已中断」**。技术侧两者都能做，但卡面文案不同。

---

## 7. 测试计划

小程序测试域的既有模式：`test/<域>/tsconfig.json` 把 `miniprogram/**/*.ts` 编译到独立 build 目录，
测试 JS 再 `require` 编译产物（参考 `test/ai-failure/` 与 `test/work-sync/`）。
本方案新增 **`test/auth-session/`** 域，沿用同一形态。

**注意新域必须 stub `globalThis.wx`**（`token-storage` 依赖 `wx.getStorageSync/setStorageSync`），
这是现有域没遇到过的新基建点，需要一并做掉。清单：

1. **登出后立即失效（回归守卫，本问题的核心证据）**：
   `getUsableSession()` 返回有效 session → 清 storage → 再调用应返回 `null`。
   这条在旧实现下是**红的**（旧实现会返回缓存）—— 用失败来证明修复确实生效。
2. **登录后可读**：`saveAuthSession` 后 `getUsableSession()` 原样返回。
3. **过期判定**：`expiresAt` 已过的 session → `null`（含 `EXPIRY_SKEW_MS` 提前量）。
4. **脏数据**：token 长度不足 / `expiresAt` 非日期串 → `null`，不抛异常。
5. **`requireUsableSession()` 错误契约**：拿不到时抛 `ApiError` 且 `code === 'AUTH_REQUIRED'`。
6. **无副作用断言**：调用 `getUsableSession()` 后，storage 内容字节级不变。
   这条守的是「读不得越权写入」。
7. **静态依赖图守卫（建议加）**：断言编译产物里 `content-security-service.js` /
   `ai-generation-service.js` 的源码不再出现 `session-service` 字样。
   这是防止将来有人把 dependencies 加回去的唯一低成本手段 —— 环一旦回来，
   后续所有「走 authStore」的重构都会重新踩上 §2.2 的死锁。

**手动验证清单**

- 登录 → 进入 AI 生图 → 生成过程中在 profile 页退出登录 → 回到任务页，
  预期任务暂停/提示登录，**且抓包确认无任何带旧 token 的请求发出**（这是本 P1 的直接证据）。
- 登录后不重启、直接触发一次图片上传（内容安全），确认不产生第二次 `wx.login`。
- 冷启动首登：确认不再出现「同步作品时卡住」—— 这是 §2.2 死锁的兜底验证。

---

## 8. 变更风险与回归清单

| 风险 | 说明 | 缓解 |
|---|---|---|
| AI 轮询静默登录被移除 | token 过期时进行中任务不再自动恢复 | §6 降级语义 + 产品确认文案 |
| 静默登录消失，以往「总能成功」的路径现在可能提示登录 | token 过期后部分操作首次会遇到 | 逐调用点过一遍 §6 矩阵 |
| `AUTH_REQUIRED` 是新错误码 | 需在 `friendlyAuthError` / AI 失败码表里登记，否则退化成兜底文案 | 参照 MEMORY 中「AI 失败码三层登记」约定，三处都要加 |
| `test/auth-session` 域需 `globalThis.wx` stub | 现有域无先例 | 阶段 B 一并做 |

**不该变的地方**（用于判断是否改过头）：storage 的读写仍在 `token-storage.ts`；
authStore 状态机 (`guest/restoring/...`) 不改；服务端零改动。

---

## 9. 任务拆解

| # | 任务 | 阶段 | 依赖 |
|---|---|---|---|
| 1 | `content-security-service` 改显式传 token | A | — |
| 2 | `work-sync-service` + `auth-store.restoreAccountData` + `app.ts:52` 适配 | A | 1 |
| 3 | 三个页面调用点适配 | A | 1 |
| 4 | 新建 `test/auth-session` 域 + `wx` stub + 用例 2-6 | B | — |
| 5 | 重写 `session-service` 为同步无状态读取器 | B | — |
| 6 | AI 三处服务改为显式传 token + flow/manager 降级 | B | 5 |
| 7 | 用例 1（登出守卫）与 7（依赖图守卫）补齐 | B | 5, 6 |
| 8 | `AUTH_REQUIRED` 三处登记 + `friendlyAuthError` 文案 | B | 5 |
| 9 | 手动验证清单走查 | C | 7 |

阶段 A 可独立合并；阶段 B 是真正修复 P1 的部分。**建议 A 与 B 分两个 PR**，
出问题时的回滚边界更清楚。

---

## 10. 遗留项

- **`test/miniprogram-assets` 之类的既有域若引用了 `ensureLoggedInSession`**，需随任务 5 一起收敛
  （调研中未发现，实施时以编译报错为准）。
- **「未登录到底该怎么引导」目前没有统一 helper**：`packages/account/privacy/index.ts:8-11`
  自己读 storage 再 `authStore.refresh()`，`pages/home/index.ts` 又会各自实现一遍。
  本次建议抽一个 `ensureLoginOrNavigate()` 供所有页面复用，但这属于顺手重构，可单独做。
- **`pindou_auth_sessions` 清理任务**：会话膨胀问题是本方案的附带收益而非解决目标，仍需单独立项。
