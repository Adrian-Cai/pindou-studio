# AI 生成任务化改造方案

> 目标：把 AI 生成从「全局单任务 + 阻塞式等待页」改造为「多任务队列 + 作品占位卡片」，
> 让上一轮生成不再阻塞主链路，成功写入作品、失败留在作品里可重试。

版本：v1 · 状态：待评审 · 影响面：小程序主包 services / pages/home / pages/projects / packages/ai-generation

---

## 1. 问题现象

用户操作路径：

1. 首页选图 A → AI 模式 → 点「开始生成」→ 进入 AI 生成页，开始转圈
2. 点返回，回到首页
3. 选图 B → 再点「开始生成」
4. 结果：页面一直卡在「AI 生成中」，按钮不可再点，主链路被阻塞；
   即使最终出结果，也大概率是**图 A 的图纸**，不是图 B

期望行为：

- 上一轮任务继续在后台跑，不阻塞我发起下一轮
- 每一轮任务在「作品」里各占一条记录
- 生成中 → 显示进行中；失败 → 显示失败并可重试；成功 → 变成真正的作品

---

## 2. 根因分析

结论：**AI 生成目前是全局单例，不是任务队列。** 单例的 session 被新任务覆盖，
但单例的 flow 还挂在旧任务上，两者互相打架，最终表现为"永久加载中"。

### 2.1 单例会话存储

`miniprogram/services/ai-generation-session.ts`

```ts
export const AI_GENERATION_SESSION_STORAGE_KEY = 'pindou-ai-generation-session-v1'

export function saveAiGenerationSession(session: AiGenerationSession): void {
  wx.setStorageSync(AI_GENERATION_SESSION_STORAGE_KEY, session)   // 只有一个 key，直接覆盖
}
```

全局只有**一个** `AiGenerationSession`。物理上不可能同时存在两个任务。

### 2.2 单例执行器

`miniprogram/services/ai-generation-manager.ts`

```ts
export class AiGenerationManager {
  private flow: AiGenerationFlow | null = null        // ← 只有一个 flow

  ensureFlowRunning(): void {
    if (this.flow) return                             // ← 已有 flow 就直接复用，不管它跑的是哪个任务
    ...
    this.flow = new AiGenerationFlow({ allowBackground: true, ... })
    this.flow.start()
  }

  attachView(callbacks: AiGenerationFlowCallbacks): void {
    this.viewCallbacks = callbacks
    this.ensureFlowRunning()
    if (this.flow) {
      this.flow.attachView(callbacks)                 // ← 把新页面的回调挂到旧任务的 flow 上
    }
  }
}
```

`AiGenerationFlow` 自身也把 `session` / `lastGeneration` / `requestSequence` / `pollTimer`
全部绑死在一个任务实例上（`ai-generation-flow.ts` L80-93）。

### 2.3 进页面时无条件覆盖会话

`miniprogram/packages/ai-generation/index.ts`

```ts
function ensureAiSession(): void {
  const draft = appStore.getSnapshot().currentDraft
  if (!draft?.id.startsWith('ai-pending-')) return
  const existing = loadAiGenerationSession()
  if (existing?.sourceImagePath === draft.sourceImagePath && existing.status !== 'failed') {
    ...   // 同一张图 → 复用
    return
  }
  saveAiGenerationSession({            // ← 不同图 → 直接把旧会话整体覆盖掉
    idempotencyKey: createIdempotencyKey(),
    jobId: null, inputFileId: null,
    sourceImagePath: draft.sourceImagePath,
    status: 'uploading', ...
  })
}
```

### 2.4 阻塞链路完整时序

```
[任务 A]
首页 startAiCreating(A)
  └─ createPendingDraft(A) → setCurrentDraft
  └─ navigateToAiGeneration
       └─ onLoad → ensureAiSession()  → storage = session(A)
       └─ attachView → ensureFlowRunning() → new Flow(A)
            └─ 上传 → createAiGeneration → jobId=jobA → 开始 4s 轮询

用户返回 ─ onHide/onUnload → detachView()
  ⚠ manager.flow 仍然存活（allowBackground=true），继续轮询 jobA
  ⚠ storage 里仍是 session(A)

[任务 B]
首页 startAiCreating(B)
  └─ createPendingDraft(B) → setCurrentDraft
  └─ navigateToAiGeneration
       └─ onLoad → ensureAiSession()
            existing.sourceImagePath = A ≠ B  →  ⚠ storage = session(B)，jobId=null
       └─ attachView → ensureFlowRunning()
            ⚠ this.flow 还在（是任务 A 的）→ 直接 return
            ⚠ 于是 flow.attachView(页面 B 的回调)
            → 页面 B 渲染的是【任务 A】的状态机：processing / "AI 正在优化图片"

       ⚠ 随后 Flow(A) 走到 handleGeneration() → saveAiGenerationSession(sessionA)
            → storage 又被写回 session(A)，任务 B 刚写的记录被冲掉，jobId 永远为 null
            → 任务 B 从未被真正创建

       ⚠ 用户看到：按钮持续"AI 生成中"，无法再发起新任务（主链路死锁）
       ⚠ jobA 完成后 onDraftReady 回调给页面 B → 保存的是【图 A 的图纸】
```

三个故障点叠加：**会话覆盖**、**flow 复用错配**、**状态回写覆盖新会话**。

### 2.5 次生问题

| # | 问题 | 位置 |
|---|------|------|
| S1 | 作品页的 AI 卡片是**虚拟**的（`id: 'ai-active-task'` 硬编码），不在 `appStore.works` 里，导致重命名/删除/筛选全部要写特判 | `pages/projects/index.ts` L107-129, L162-165, L192-195, L242, L337-350 |
| S2 | 只能显示**一个**任务，第二张图的任务在作品页根本看不到 | 同上 |
| S3 | `sourceImagePath` 用的是 `wx.chooseMedia` 的**临时路径**，App 重启或长时间后失效 → 占位封面白图、重试必失败 | `pages/home/index.ts` L153 |
| S4 | 每个任务各自 `setTimeout` 轮询，多任务后定时器数量线性增长，且彼此不同步 | `ai-generation-flow.ts` L440-448 |
| S5 | 冷启动只恢复单一 session，且 `status === 'failed'` 的直接丢弃，失败任务无法从作品页找回 | `ai-generation-manager.ts` L34-39 |
| S6 | 小程序切后台（`App.onHide`）后 JS 被挂起，定时器不可靠；`onAppShow` 没有统一的追赶（catch-up）机制 | `app.ts` 未处理 |
| S7 | 服务端有 `aiRateLimiter.check(userId:generation)`，客户端无并发上限，多任务可能撞限流 | `server/src/http/app.ts` L504 |

---

## 3. 目标 / 非目标

### 目标

- **G1 零阻塞**：发起生成后立即返回可交互状态，可连续发起多个任务
- **G2 即时落库**：点生成的那一刻就在作品列表写入一条占位记录（带原图封面）
- **G3 多任务并行**：N 个任务各自独立状态机，互不覆盖
- **G4 终态明确**：成功 → 转真作品；失败 → 留在作品里显示失败 + 可重试；超时 → 自动判失败
- **G5 可恢复**：冷启动、切后台回来、任意页面进出，任务都能续上
- **G6 可管理**：作品列表里能重命名、删除（= 取消任务）、重试

### 非目标

- 不做跨设备同步（本期任务记录只存本地）
- 不改后端 AI Provider 与配额模型
- 不做推送/订阅消息通知（P2）

---

## 4. 目标架构

```
┌─────────────────────────────────────────────────────────────┐
│  页面层（只订阅，不驱动）                                      │
│  pages/home        pages/projects      packages/ai-generation │
│  发起任务           展示占位/失败卡片     单任务详情 ?taskId=   │
└───────────┬───────────────┬──────────────────┬──────────────┘
            │               │                  │
            ▼               ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│  AiTaskManager（单例，但管的是"一组任务"）                     │
│  · Map<taskId, AiGenerationFlow>                             │
│  · 统一 tick 调度器（单个定时器，批量轮询）                    │
│  · 并发槽位 MAX_CONCURRENT = 2                                │
│  · subscribe(taskId) / subscribeAll()                        │
└───────────┬─────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│  AiTaskStore（任务持久化，数组而非单对象）                      │
│  storage: pindou-ai-tasks-v1 → AiTask[]                      │
└───────────┬─────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│  AppStore.works（真实作品记录，含 ai_pending / ai_failed）     │
└─────────────────────────────────────────────────────────────┘
```

**核心变化：任务 ID 是一等公民。** 页面通过 `taskId` 绑定任务，而不是靠"当前全局唯一任务"。

---

## 5. 数据模型

### 5.1 AiTask

```ts
// miniprogram/services/ai-task-store.ts

export type AiTaskStatus =
  | 'created'      // 已建占位，等待槽位
  | 'uploading'    // 上传输入图
  | 'submitting'   // 创建远端任务
  | 'queued'       // 远端排队
  | 'processing'   // 远端处理
  | 'downloading'  // 下载 AI 输出
  | 'converting'   // 标准图案引擎转网格
  | 'succeeded'    // 终态
  | 'failed'       // 终态

/** 展示用进度（服务端无精确百分比，沿用现有估算策略） */
const PHASE_PROGRESS: Record<AiTaskStatus, number> = {
  created: 5, uploading: 12, submitting: 28, queued: 45,
  processing: 68, downloading: 86, converting: 94,
  succeeded: 100, failed: 100,
}

export interface AiTask {
  /** 本地唯一 ID，同时作为作品 ID（taskId === workId） */
  taskId: string
  status: AiTaskStatus
  /** 服务端任务 ID，创建成功后才有 */
  jobId: string | null
  /** 已上传的输入文件 ID，重试时可复用，避免重复上传 */
  inputFileId: string | null
  idempotencyKey: string
  securityCheckId?: string
  /** 已永久化的原图路径（wx.env.USER_DATA_PATH） */
  sourceImagePath: string
  /** 已永久化的内容安全检测压缩图路径 */
  inputImagePath?: string
  /** AI 输出图本地路径 */
  outputImagePath: string
  settings: PatternSettings
  style: AiGenerationStyle
  detailLevel: AiGenerationDetailLevel
  backgroundMode: AiGenerationBackgroundMode
  failure: AiGenerationFailure | null
  retryCount: number
  createdAt: number
  updatedAt: number
  /** 进入 processing 的时间，用于超时判定 */
  startedAt: number | null
  finishedAt: number | null
}
```

### 5.2 WorkItem 扩展

```ts
// miniprogram/models/pattern.ts
export interface WorkItem {
  ...
  /** 新增 ai_pending / ai_failed；原有 draft / completed 语义不变 */
  status?: 'draft' | 'completed' | 'ai_pending' | 'ai_failed'
  /** 关联的任务 ID，非 AI 作品不带 */
  aiTaskId?: string
  /** 失败原因，卡片上直接展示 */
  failureCode?: string
  failureMessage?: string
}
```

判定辅助（放在 `models/pattern.ts`）：

```ts
export function isAiTaskWork(work: WorkItem): boolean {
  return work.status === 'ai_pending' || work.status === 'ai_failed'
}
export function isWorkDraft(work: WorkItem): boolean {
  return work.status !== 'completed'   // ai_pending / ai_failed / draft 都算未完成
}
```

### 5.3 存储

| key | 内容 | 说明 |
|-----|------|------|
| `pindou-ai-tasks-v1` | `AiTask[]` | 新增；上限 20 条，超出淘汰最老的终态任务 |
| `pindou-ai-generation-session-v1` | 旧单例 | 迁移后删除 |

---

## 6. 模块设计

### 6.1 新增 `services/ai-task-store.ts`

纯持久化层，无业务逻辑：

```ts
export function listAiTasks(): AiTask[]
export function getAiTask(taskId: string): AiTask | null
export function createAiTask(input: CreateAiTaskInput): AiTask
export function patchAiTask(taskId: string, patch: Partial<AiTask>): AiTask | null
export function removeAiTask(taskId: string): void
/** 非终态任务，按 createdAt 升序 */
export function listActiveAiTasks(): AiTask[]
/** 清理：终态且超过 7 天、超上限、以及 sourceImagePath 已失效的 */
export function pruneAiTasks(): void
```

要点：
- 所有写入必须**只读改自己那一条**，禁止整体覆盖数组
- `patchAiTask` 自动维护 `updatedAt`
- 读时做结构校验，脏数据单条丢弃而不是整数组失效

### 6.2 改造 `services/ai-generation-manager.ts` → 任务管理器

```ts
const MAX_CONCURRENT = 2
const TICK_INTERVAL_MS = 4_000
const TASK_TIMEOUT_MS = 15 * 60_000
const QUEUE_MAX = 10

export class AiTaskManager {
  private flows = new Map<string, AiGenerationFlow>()
  private waiting: string[] = []                       // 排队中的 taskId，FIFO
  private tickTimer: ReturnType<typeof setTimeout> | null = null
  private taskListeners = new Map<string, Set<AiTaskListener>>()
  private globalListeners = new Set<AiTaskListener>()

  /** App.onLaunch：加载 → 过期判定 → 入队恢复 */
  init(): void
  /** App.onShow：立即追赶一次（后台期间定时器不可靠） */
  onAppShow(): void
  /** App.onHide：停 tick，保留状态 */
  onAppHide(): void

  /** 首页发起：建任务 → 落库作品 → 入队 → 立刻返回 */
  async createTask(input: CreateTaskInput): Promise<string>
  /** 作品页/详情页重试 */
  async retryTask(taskId: string): Promise<void>
  /** 取消：destroy flow + 删任务 + 删占位作品 */
  async cancelTask(taskId: string): Promise<void>

  /** 单任务订阅（详情页用） */
  subscribeTask(taskId: string, listener: AiTaskListener): () => void
  /** 全量订阅（作品页用） */
  subscribeAll(listener: AiTaskListener): () => void

  /** 页面渲染用的视图模型 */
  getTaskView(taskId: string): AiTaskView | null
  listTaskViews(): AiTaskView[]
}
```

**统一 tick 调度**（替换每任务一个定时器）：

```ts
private startTick(): void {
  if (this.tickTimer !== null) return
  this.tickTimer = setTimeout(() => {
    this.tickTimer = null
    void this.tick()
  }, TICK_INTERVAL_MS)
}

private async tick(): Promise<void> {
  this.pumpQueue()                                     // 补槽位：waiting → running
  this.markTimeoutTasks()                              // 超时 → failed(AI_TIMEOUT)
  const polling = [...this.flows.values()].filter(f => f.needsPoll())
  for (const flow of polling) {                        // 串行，避免并发打爆服务端
    await flow.pollOnce()
  }
  if (this.flows.size > 0 || this.waiting.length > 0) this.startTick()
}
```

### 6.3 改造 `services/ai-generation-flow.ts`

| 现状 | 改造后 |
|------|--------|
| 构造只吃 callbacks | `new AiGenerationFlow({ taskId, onTaskChange })` |
| 读写全局 `loadAiGenerationSession()` | 只读写自己的 `getAiTask(taskId)` / `patchAiTask(taskId, ...)` |
| 自己 `setTimeout` 轮询 | 暴露 `needsPoll()` / `pollOnce()`，由 manager tick 驱动 |
| `onDraftReady` 回调给页面 | 回调给 manager，由 manager 统一落库后再通知订阅者 |
| `allowBackground` 暂停语义 | 删除；后台/前台由 manager 的 `onAppHide/onAppShow` 统一控制 |

保留不变：上传 → 创建 → 轮询 → 下载 → `createDraft` 的状态机、退避策略 `[8s, 15s, 30s]`、
失败码映射（`ai-generation-service.ts` 全部复用）。

**关键：`createDraft` 需要支持指定 ID**，否则作品 ID 对不上：

```ts
// services/image-service.ts
export async function createDraft(
  sourceImagePath: string,
  settings: Partial<PatternSettings>,
  generationMode: GenerationMode = 'standard',
  options?: { id?: string },
): Promise<PatternDraft>
// → id: options?.id ?? 'draft-' + now
```

### 6.4 删除 `services/ai-generation-session.ts`

单例会话整体下线（保留一个迁移函数，见 §9）。

---

## 7. 关键流程

### 7.1 发起生成（首页）— 零阻塞

```ts
// pages/home/index.ts
async startAiCreating(): Promise<void> {
  if (this.data.submitting) return
  // ...原有图片/安检校验...

  this.setData({ submitting: true })
  try {
    // 1) 图片永久化：临时路径失效会导致封面白图 & 重试失败
    const sourceImagePath = await persistImage(this.data.sourceImagePath)
    const inputImagePath  = await persistImage(this.data.contentSecurityImagePath)

    // 2) 建任务 + 立刻落库作品（这一步同步完成，用户马上能在作品页看到卡片）
    const taskId = await aiTaskManager.createTask({
      sourceImagePath, inputImagePath,
      securityCheckId: this.data.securityCheckId,
      settings: this.data.settings,
      ...DEFAULT_AI_OPTIONS,
    })

    // 3) 不跳转、不阻塞；给一个非模态反馈
    wx.showToast({ title: '已加入生成队列', icon: 'none', duration: 1500 })
    this.resetUploadState()      // 清空选图状态，立即可选下一张
  } finally {
    this.setData({ submitting: false })
  }
}
```

> 决策点：是否仍跳转到 AI 生成页？
> **建议改为不跳转**，直接 toast + 顶部胶囊「N 个生成中 · 查看」。
> 理由：跳转本身就意味着"我要等它"，与 G1 冲突；且跳转后返回再进会重新触发 attach。
> 若产品坚持保留进度页，则必须带 `?taskId=`，且该页面按 §10.3 改造为**任务详情页**
> （可绑定任意任务），而不是现在的"唯一生成页"（靠全局单例 session 猜任务）。

新增轻量提示（`pages/home/index.wxml` 顶部）：

```
生成中 2 个 · 查看 ›        ← 有任务时才显示，点击 switchTab 到作品页
```

### 7.2 任务执行

```
createTask
  ├─ aiTaskStore.createAiTask()            status = 'created'
  ├─ appStore.saveWork(pendingWork)        作品列表立即出现占位卡片
  ├─ waiting.push(taskId)
  └─ pumpQueue() → 有槽位则 new Flow(taskId).start()

Flow 生命周期
  created → uploading   （POST /api/files/upload）
          → submitting  （POST /api/ai/generations，Idempotency-Key）
          → queued / processing（GET /api/ai/generations/{id}，tick 驱动）
          → downloading （wx.downloadFile 输出图 → 永久化）
          → converting  （createDraft(output, settings, 'ai', { id: taskId })）
          → succeeded
  任一环失败 → failed（含 failure code/message/retryable）
```

**成功落库**（manager 统一执行，不再依赖页面回调）：

```ts
private async finalizeSuccess(taskId: string, draft: PatternDraft): Promise<void> {
  await appStore.saveLocalDraft(draft, false)          // 不抢占 currentDraft
  await appStore.saveWork({
    id: taskId,
    title: 'AI 拼豆图',
    coverPath: draft.sourceImagePath,
    generationMode: 'ai',
    status: 'draft',                                    // ai_pending → draft
    beadCount, colorCount, width, height,
    syncStatus: hasCloudSession() ? 'pending' : 'guest',
    updatedAt: Date.now(),
  })
  patchAiTask(taskId, { status: 'succeeded', finishedAt: Date.now() })
  this.flows.delete(taskId)
  this.notifyAll()
  // 用户不在该任务页时：只做轻提醒，不打断
  wx.vibrateShort({ type: 'light', fail: () => undefined })
}
```

**失败落库**：

```ts
private async finalizeFailure(taskId: string, failure: AiGenerationFailure): Promise<void> {
  patchAiTask(taskId, { status: 'failed', failure, finishedAt: Date.now() })
  await appStore.saveWork({
    ...existingWork,
    status: 'ai_failed',
    failureCode: failure.code,
    failureMessage: failure.message,
    updatedAt: Date.now(),
  })
  this.flows.delete(taskId)
  this.notifyAll()
}
```

### 7.3 重试

- 入口：作品页失败卡片「重试」按钮、AI 任务详情页「重试」
- 策略：`inputFileId` 仍有效 → 直接 `createAiGeneration`（跳过上传）；否则重新上传
- 每次重试 `idempotencyKey = createIdempotencyKey()`（沿用现有逻辑）
- `retryCount` 上限 3，超出后卡片提示"请重新选图生成"

### 7.4 取消

- 入口：作品页 pending/failed 卡片「删除」
- 行为：`flow.destroy()` → `removeAiTask(taskId)` → `appStore.deleteWork(taskId)`
- 不调用后端取消接口（后端当前无该能力，任务自然过期即可）

---

## 8. 并发、限流与超时

| 项 | 策略 | 理由 |
|----|------|------|
| 客户端并发上限 | `MAX_CONCURRENT = 2` | 服务端 `aiRateLimiter.check(userId:generation)` 存在，需与后端确认阈值后再调 |
| 队列上限 | `QUEUE_MAX = 10` | 超出提示"生成任务过多，请稍后再试" |
| 轮询节奏 | 统一 tick 4s，串行发起 | 单定时器，N 个任务也只有 4s 一次批量请求 |
| 网络退避 | 失败计数 1/2/3 → 8s / 15s / 30s | 沿用现有 `NETWORK_BACKOFF_MS` |
| 单任务超时 | 15 min 未终态 → `failed(AI_TIMEOUT)` | 后端输入输出 24h 过期；15min 是体感上限 |
| 任务留存 | 终态任务 7 天后清理；数组上限 20 | 控制 storage 体积 |
| 前后台 | `onAppHide` 停 tick，`onAppShow` 立即追赶一次 | 小程序后台 JS 被挂起，定时器不可靠 |

---

## 9. 生命周期与恢复

```ts
// app.ts
App({
  onLaunch() {
    ...
    aiTaskManager.init()        // 加载任务 → 标记超时 → 补偿缺失的 WorkItem → 入队恢复
  },
  onShow() {
    aiTaskManager.onAppShow()   // 立即 catch-up 一次
  },
  onHide() {
    aiTaskManager.onAppHide()   // 停 tick
  },
})
```

`init()` 内的**自愈**逻辑（关键，防止任务和作品不一致）：

1. `pruneAiTasks()` 清理垃圾
2. 遍历任务：
   - 超过 `TASK_TIMEOUT_MS` 未终态 → 标记 `failed(AI_TIMEOUT)`
   - `sourceImagePath` 文件不存在 → 标记 `failed(INVALID_IMAGE)`
   - `status` 为终态但作品缺失 → 补写 WorkItem
   - `status` 非终态但作品缺失 → 补写 `ai_pending` WorkItem
3. 非终态任务按 `createdAt` 入队

### 数据迁移（`pindou-ai-generation-session-v1` → v1）

```ts
export function migrateLegacyAiSession(): void {
  const legacy = loadAiGenerationSession()      // 旧函数，迁移完删除
  if (!legacy) return
  clearAiGenerationSession()
  if (legacy.status === 'succeeded' || legacy.status === 'failed') return  // 终态不迁

  const task = createAiTask({ ...legacy, status: legacy.status === 'uploading' ? 'created' : 'processing' })
  // 有 jobId 的直接续跑；没有 jobId 的重新上传
  appStore.saveWork({ id: task.taskId, ... status: 'ai_pending' })
}
```

在 `AiTaskManager.init()` 最前面调用，只执行一次（迁移后用 `pindou-ai-tasks-migrated-v1` 标记位）。

---

## 10. 页面改造清单

### 10.1 `pages/home/index.ts`

- [ ] 删除 `createPendingDraft` 传参链路，改为 `aiTaskManager.createTask()`
- [ ] `startAiCreating` 不再 `navigateToAiGeneration`（或改为带 `taskId` 的详情跳转）
- [ ] 增加 `submitting` 状态，`generating` 语义收窄
- [ ] 新增 `persistImage()` 调用（图片永久化）
- [ ] 顶部新增「生成中 N 个」胶囊入口
- [ ] `onShow` 订阅 `aiTaskManager.subscribeAll()` 刷新胶囊计数

### 10.2 作品卡片三态设计（生成中 / 失败 / 完成）

> 产品确认：AI 任务在作品页以**真实作品记录**呈现（与方案方向一致）。
> 现有 `projects/index.wxml` 已有 `isAiGenerating` / `isAiFailed` 分支骨架（L56-78 状态 pill、
> 操作行裁剪、L79-89 查看进度/查看重试），主要工作是把数据源从虚拟 `ai-active-task`
> 换成真实 `WorkItem`，并补齐下表细节。

| | 生成中（`ai_pending`） | 失败（`ai_failed`） | 完成（`draft`/`completed`） |
|---|---|---|---|
| **封面** | 原图 + 半透明遮罩 + 进度「约 N%」 | 原图 + 灰色遮罩 + 失败标识 | 原图（现状） |
| **标题** | 默认「AI 拼豆图」（本地字段，随时可改） | 同左 | 用户标题 |
| **状态标签** | `生成中`（绿） | `生成失败`（红） | `草稿` / `已完成` |
| **元信息** | `96×96 · 32色`（按任务设置预填）+ 提交时间 | 同左 + **一行失败原因**（`failureMessage`） | 现状 |
| **操作行** | 仅「取消任务」 | 「重试」+「重命名」+「删除」 | 重命名/下载/删除（现状） |
| **点卡片** | 进任务详情页看进度 | 进任务详情页看原因 | 正常打开 |

设计说明与边界：

1. **封面不空白**：原图在发起时已永久化（§7.1），生成中显示原图 + 遮罩 + 进度，
   比"纯占位灰块"信息量大得多，用户能认出这是哪张图。遮罩用 `position:absolute` 覆盖层，
   不动 `project-card__cover` 本体。
2. **生成中为什么不给「重命名」**：产品要求三个操作全部置灰。技术上重命名只是本地字段
   本可放开，但保持"生成中 = 只读 + 可取消"的心智更简单，采纳。
3. **失败态为什么放开「重命名」**：失败后作品已经存在（只是没图纸），标题属于本地数据，
   与任务成败无关；同时给「重试」作为唯一主操作。
4. **失败原因直接上卡片**：一行 `failureMessage`（如「AI 生成次数不足，请购买次数」），
   避免用户必须点进去才知道为什么失败。文案复用 `aiGenerationErrorMessage()` 的映射。
5. **按失败类型区分重试动作**：
   - `retryable=true`（网络/服务繁忙/超时等）→ 「重试」
   - `VIEW_BENEFITS`（次数不足）→ 「购买次数」
   - `SELECT_IMAGE` / `CONTENT_REJECTED`（图片本身不行）→ 不给重试，按钮文案「重新选图生成」，
     点击回首页（复用旧图没有意义）
   - `USE_STANDARD_MODE`（AI 服务不可用）→ 「用标准模式生成」
6. **失败不吞次数**：配额在服务端 `create` 时扣减、任务失败时退还（后端既有约定，
   见 `AI_GENERATION_DESIGN.md`），客户端只负责展示 `failureCode` 对应文案，不自行判断。
7. **任务被取消**（用户主动删卡片）：直接 `cancelTask` + 删记录，不留失败态。
   只有**服务端/网络导致的失败**才走 `ai_failed`。

对应的 WXML 改动点（现有骨架上微调）：

```xml
<!-- 操作行：三态分流 -->
<view wx:if="{{item.status === 'ai_pending'}}" class="project-card__actions-inline">
  <view class="project-card__action-inline project-card__action-inline--danger"
        data-id="{{item.id}}" catchtap="cancelAiTask">取消任务</view>
</view>
<view wx:elif="{{item.status === 'ai_failed'}}" class="project-card__actions-inline">
  <view class="project-card__action-inline" data-id="{{item.id}}" catchtap="retryAiTask">重试</view>
  <view class="project-card__action-inline" data-id="{{item.id}}" catchtap="startRename">重命名</view>
  <view class="project-card__action-inline project-card__action-inline--danger"
        data-id="{{item.id}}" catchtap="deleteWork">删除</view>
</view>
<view wx:else class="project-card__actions-inline"><!-- 现状 --></view>
```

进度/失败遮罩（封面右上角叠一层）：

```xml
<view class="project-card__cover-wrap">
  <image class="project-card__cover" src="{{item.coverPath}}" ... />
  <view wx:if="{{item.status === 'ai_pending'}}" class="project-card__overlay">
    <text>{{item.progressText}}</text>
  </view>
  <view wx:elif="{{item.status === 'ai_failed'}}" class="project-card__overlay project-card__overlay--failed">
    <text>生成失败</text>
  </view>
</view>
```

数据侧（`refreshVisibleWorks`）给每条 AI 记录补派生字段：

```ts
progressText: status === 'ai_pending' ? `约 ${aiProgress}%` : undefined,
failureMessage: status === 'ai_failed' ? work.failureMessage : undefined,
```

`refreshVisibleWorks()` 的触发源：`aiTaskManager.subscribeAll()`（任务每次 patch 都会 notify），
进度数字随 tick 自然刷新，无需页面自己起定时器。

### 10.2.1 `pages/projects/index.ts`

- [ ] **删除** `id: 'ai-active-task'` 虚拟卡片（L107-129）
- [ ] 改为从 `appStore.works` 渲染真实记录：
  ```ts
  const works = state.works.map((work) => ({
    ...work,
    isAiGenerating: work.status === 'ai_pending',
    isAiFailed: work.status === 'ai_failed',
    statusLabel: statusLabel(work),     // 草稿 / 已完成 / AI生成中 / 生成失败
  }))
  ```
- [ ] 删除所有 `id === 'ai-active-task'` 特判（L162/164/192/200/242/327/336）
- [ ] 删除逻辑改为：`isAiTaskWork(work)` → `aiTaskManager.cancelTask(work.id)`
- [ ] 失败卡片增加「重试」按钮 → `aiTaskManager.retryTask(work.id)`
- [ ] 点 pending/failed 卡片 → `navigateTo('/packages/ai-generation/index?taskId=' + work.id + '&from=projects')`
      （当前是**不带参**的裸跳转，正是靠全局单例 session 才能"猜"出任务的原因）
- [ ] 订阅改为 `subscribeAll()`，`onShow` 订阅 / `onHide` 退订

### 10.3 任务详情页：复用 `packages/ai-generation`，不新建页面

> **澄清**：项目当前没有独立的任务详情页，`packages/ai-generation/index` 是唯一的
> 「AI 生成等待页」（`page-layout title="AI 生成"`，内容为进度卡 + 失败态按钮组）。
> 本方案**不新建页面**，而是把它改造为「任务详情页」，同时承担两个入口：
> ① 首页发起后（若保留跳转）看进度；② 从作品页点某条 pending/failed 记录进来查看/操作。

**为什么复用而不是新建**：两个入口要展示的东西本质相同（任务状态、进度、失败原因、
重试/取消），新建页面会导致两套几乎相同的状态渲染逻辑各自演化，是这次出问题的同款隐患。
代价是这个页面要同时覆盖「等待中」和「查看详情」两种语气，靠 `taskId` + 状态区分。

#### 10.3.1 路由与入参

```
/packages/ai-generation/index?taskId=<taskId>&from=<home|projects>
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `taskId` | 否 | 绑定的任务。缺省时取最近一个活跃任务；**都没有 → `switchTab` 回首页**（不再出现"无任务却停在生成页"） |
| `from` | 否 | `home` / `projects`，仅影响底部 tab 高亮与返回意图，默认 `home` |

#### 10.3.2 页面改造清单

- [ ] `onLoad(query)` 解析 `taskId` / `from`，`selectedTab` 由 `from` 决定（`projects` → 1，否则 0）
- [ ] `aiTaskManager.subscribeTask(taskId, listener)` 替代 `aiGenerationManager.attachView()`
- [ ] **删除 `ensureAiSession()`**（就是它无条件覆盖全局会话）
- [ ] `onHide/onUnload` 只退订，**不再影响任务执行**
- [ ] 页面 `onShow` 时重新拉取一次任务快照（后台回来后状态可能已变）

#### 10.3.3 需要补齐的能力（当前页面没有的）

现有页面只覆盖「生成中」和「失败」两态，改造后必须补齐：

| 能力 | 现状 | 改造后 |
|------|------|--------|
| **排队中**（`created` / 等待并发槽位） | ❌ 无对应 UI，会落到 `loading` 卡 | 新增：显示「排队中，前方还有 N 个」+ 取消按钮 |
| **取消任务** | ❌ 失败态只有「返回首页」 | 所有非终态都提供「取消生成」按钮 → `aiTaskManager.cancelTask()` |
| **任务元信息** | ⚠️ 仅生成中通过底部面板展示尺寸/色数 | 卡片区常驻：原图缩略图 + 尺寸 × 色数 + 提交时间 |
| **成功后的去向** | 一律 `redirectTo` 编辑器 | 按来源区分：<br>· `from=home`（刚发起）→ 跳编辑器<br>· `from=projects`（回看）→ **不跳转**，卡片变「已完成」+ 「查看作品」按钮 |
| **任务已完成/已取消后来访** | ❌ 会卡在 loading | 终态任务直接进入只读态：`succeeded` 显示「查看作品」，`failed` 显示失败原因 + 重试 |

#### 10.3.4 页面状态映射

| task.status | 展示 | 主操作 |
|-------------|------|--------|
| `created` | 排队中卡片（含队列位次） | 取消生成 |
| `uploading` / `submitting` / `queued` / `processing` / `downloading` / `converting` | `generating-preview-card` + 阶段进度 | 取消生成 |
| `succeeded` | 成功卡片 | 查看作品 |
| `failed` | 失败卡片 + `failureMessage` | 重试（retryable）/ 购买（VIEW_BENEFITS）/ 重选图（SELECT_IMAGE）/ 用标准模式 |

#### 10.3.5 一个必须处理的边界

用户停留在该页面时任务才完成 —— 当前实现 `onDraftReady` 里直接 `redirectTo` 编辑器，
改造后若 `from=projects` 不应强制跳转（用户只是回来看一眼）。
判断方式：`onLoad` 时记下 `from`，`onDraftReady` 回调里按 `from` 分流。

### 10.4 `components/generating-preview-card`

- [ ] 复用为作品列表里的 pending/failed 卡片（接受 `isFailed` / `progress` / `phaseLabel`）
- [ ] 失败态展示 `failureMessage` + 「重试」

---

## 11. 分期落地

| 阶段 | 内容 | 风险 | 产出 |
|------|------|------|------|
| **P0 止血**（必做） | 任务化：ai-task-store + manager 多任务 + 首页不跳转 + 作品占位落库 | 中（改主链路） | 主链路不再阻塞 |
| **P1 完善** | 作品页真实卡片 + 重试/取消 + 生成页改造为任务详情页（`?taskId=` 绑定、补齐排队/取消/元信息）+ 图片永久化 | 低 | 完整任务管理闭环 |
| **P2 增强** | 冷启动自愈、`onAppShow` catch-up、超时判定、迁移脚本 | 低 | 异常场景兜底 |
| **P3 可选** | 后端 `GET /api/ai/generations`（列表，支持跨设备恢复）、订阅消息通知 | 中（需后端排期） | 换设备可恢复 |

**P0 建议先做**，因为它直接解决用户报的阻塞问题；P1 紧随，否则用户看不到任务在哪。

---

## 12. 验收用例

| # | 场景 | 期望 |
|---|------|------|
| T1 | 选图 A 生成 → 立刻返回 → 选图 B 生成 | B 能正常发起；作品页出现 2 条 pending 卡片 |
| T2 | 连续发起 5 个任务 | 最多 2 个并发，其余排队；全部最终有终态，无丢失 |
| T3 | 任务进行中杀掉 App 重进 | 未完成任务自动恢复并继续轮询 |
| T4 | 任务进行中切后台 5 分钟再回来 | 立即追赶，状态正确刷新 |
| T5 | 任务成功 | 卡片变正常作品（草稿），可打开编辑；封面正确 |
| T6 | 任务失败（断网） | 卡片显示"生成失败"，点重试能恢复 |
| T7 | 删除 pending 卡片 | 任务被取消，不再轮询，作品消失 |
| T8 | 删除 failed 卡片 | 作品删除，任务记录清理 |
| T9 | 旧版本升级上来（v1 session 存在） | 旧任务迁移为 pending 卡片，继续跑 |
| T10 | 首页连续点 5 次生成 | 不会重复建任务；按钮有 submitting 防抖 |
| T11 | 任务成功时用户在首页 | 只更新作品 + 轻提醒，不强制跳转 |
| T12 | 15 分钟未出结果 | 自动标记失败（超时），可重试 |
| T13 | 作品页点任务 A 的 pending 卡片 | 进入**任务 A** 的详情页（不是"最近一个任务"） |
| T14 | 详情页点「取消生成」 | 任务停止轮询，返回作品页后卡片已消失 |
| T15 | 任务已完成后，再从作品页点进详情页 | 显示「查看作品」，不卡在 loading，不重复生成 |
| T16 | 详情页任务失败且不可重试 | 展示失败原因 + 「返回作品页」，无无效按钮 |

---

## 13. 风险与待确认

| 风险 | 影响 | 缓解 |
|------|------|------|
| 后端 `aiRateLimiter` 阈值未知，并发 2 可能仍被限流 | 任务创建失败 | 与后端确认阈值；客户端对 `RATE_LIMITED` 做自动排队重试而非直接失败 |
| 图片永久化占用用户存储 | storage 膨胀 | 只永久化原图 + 输出图；终态任务 7 天后连同图片一起清理 |
| 移除 `createPendingDraft` / `currentDraft` 传参可能影响其他页面 | 回归风险 | 全量 grep `ai-pending-` 确认引用点；editor 侧用 `resolveGenerationMode` 兜底 |
| 首页不跳转与现有产品交互不一致 | 体验变更 | 需产品确认；保留带 `taskId` 的进度页作为备选 |
| 多任务同时完成，`saveWork` 并发写 | 数据竞争 | `appStore.persist()` 已有串行 writeTask 队列，安全 |

---

## 14. 附录：关键文件索引

| 文件 | 现状职责 | 改造动作 |
|------|----------|----------|
| `services/ai-generation-session.ts` | 单例会话 | **删除**（保留迁移函数） |
| `services/ai-task-store.ts` | — | **新增** |
| `services/ai-generation-manager.ts` | 单 flow 管理 | 重写为多任务管理器 |
| `services/ai-generation-flow.ts` | 绑定单例 session 的状态机 | 改为绑定 `taskId` |
| `services/ai-generation-service.ts` | API 封装 | 不变 |
| `services/image-service.ts` | 草稿生成 | `createDraft` 支持指定 id；新增 `persistImage` |
| `models/pattern.ts` | 数据模型 | `WorkItem.status` 扩展 |
| `store/app-store.ts` | 作品存储 | 不变（复用 `saveWork`/`deleteWork`） |
| `pages/home/index.ts` | 发起生成 | 改为建任务，不阻塞 |
| `pages/projects/index.ts` | 作品列表 | 去虚拟卡片，用真实记录 |
| `packages/ai-generation/index.ts` | AI 生成等待页 | 改造为任务详情页（**不新建页面**），见 §10.3 |
| `app.ts` | 启动 | 增加 `onShow`/`onHide` 生命周期 |
