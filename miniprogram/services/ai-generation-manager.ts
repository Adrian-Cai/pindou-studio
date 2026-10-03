/**
 * AI 生成任务管理器：全局单例，但管的是「一组任务」而不是唯一任务。
 *
 * 职责：持有 Map<taskId, AiGenerationFlow>，用单个 tick 定时器串行驱动所有任务的轮询；
 *       控制并发槽位与队列长度；负责终态落库（成功转真作品、失败留在作品里可重试）；
 *       对外提供订阅与视图模型，页面只读订阅、不驱动任务。
 * 调用方：app.ts（init / onAppShow / onAppHide）、pages/home（createTask）、
 *        pages/projects（订阅全量、重试、取消）、packages/ai-generation（订阅单个任务）。
 * 关键点：任务 ID 是一等公民，所有操作都按 taskId 定位，不存在「全局当前任务」这种概念；
 *        App 切后台时停 tick（小程序后台 JS 会被挂起，定时器不可靠），回前台立即追赶一次。
 */
import { AiGenerationFlow } from './ai-generation-flow'
import {
  aiFailureAction,
  aiGenerationErrorMessage,
  type AiGenerationFailure,
} from './ai-generation-service'
import {
  createAiTask,
  createIdempotencyKey,
  getAiTask,
  isAiTaskTerminal,
  isFilePathAlive,
  listActiveAiTasks,
  listAiTasks,
  migrateLegacyAiSession,
  patchAiTask,
  PHASE_PROGRESS,
  pruneAiTaskImages,
  pruneAiTasks,
  removeAiTask,
  type AiTask,
  type AiTaskStatus,
  type CreateAiTaskInput,
} from './ai-task-store'
import { ApiError, type PublicErrorAction } from './http-client'
import { isAiTaskWork, type PatternDraft, type PatternSettings, type WorkItem, type WorkStatus } from '../models/pattern'
import { appStore } from '../store/app-store'
import { hasCloudSession } from './work-service'

/** 同时跑的请求数上限；服务端有 aiRateLimiter，不宜放大。 */
const MAX_CONCURRENT = 2
const TICK_INTERVAL_MS = 4_000
const TASK_TIMEOUT_MS = 15 * 60_000
/**
 * 「还没轮到跑」的天花板：任务可能因为并发槽位占满或长时间不在前台而在队列里等，
 * 这段时间不该算进 15 分钟的生成超时，但也不能无限等下去——
 * 隔了这么久还没跑上，多半是卡死了，占着槽位反而挡住后面的任务。
 */
const QUEUE_WAIT_TIMEOUT_MS = 60 * 60_000
const QUEUE_MAX = 10
const MAX_RETRY_COUNT = 3
const DEFAULT_AI_WORK_TITLE = 'AI 拼豆图'

export type AiTaskListener = () => void

/** 页面渲染用的只读视图模型。 */
export interface AiTaskView {
  taskId: string
  status: AiTaskStatus
  /** 非终态（含排队中） */
  isActive: boolean
  isFailed: boolean
  isSucceeded: boolean
  /** 0-100 展示进度 */
  progress: number
  /** 在队列中的位次，1 表示下一个；0 表示已在运行或已终态 */
  queuePosition: number
  stateTitle: string
  stateDescription: string
  statusMessage: string
  waitingLong: boolean
  failureCode: string | null
  failureMessage: string
  /** 是否提供重试类操作 */
  canRetry: boolean
  /** 重试类操作的文案，按失败类型变化 */
  retryLabel: string
  action: PublicErrorAction
  showPurchase: boolean
  /** 任务设置的完整快照，切换标准模式时需要复用 */
  settings: PatternSettings
  sourceImagePath: string
  width: number
  height: number
  colorLimit: number
  createdAt: number
  updatedAt: number
}

/** 失败是否可以重试：只有 action 为 RETRY 的失败才给重试入口。 */
export function canRetryTask(failureCode?: string): boolean {
  return retryActionFor(failureCode) === 'RETRY'
}

/** 按失败类型给出卡片上的操作文案：图片/内容类问题重试同一张图没有意义。 */
export function retryActionLabel(failureCode?: string): string {
  switch (retryActionFor(failureCode)) {
    case 'VIEW_BENEFITS':
      return '购买次数'
    case 'SELECT_IMAGE':
      return '重新选图生成'
    case 'USE_STANDARD_MODE':
      return '用标准模式生成'
    default:
      return '重试'
  }
}

/**
 * 按失败码决定卡片上的操作类型。
 *
 * 动作表**只有一份**，在 ai-generation-service 的 failureDefinition 里，这里只做转发：
 * 历史上 manager 自带一张 switch、service 的 failureDefinition 自带一张 action 字段，
 * 两张表各写各的，同一个码在任务页与列表页可能给出不同按钮（IMAGE_TOO_LARGE 就曾是
 * 「可重试」与「应换图」并存）。新增失败码只需改 service 一处。
 *
 * 入参可以是归一化前或后的码：aiFailureAction 内部会 normalize，未登记的码给 SELECT_IMAGE
 * （不给重试，避免用户反复撞同一个不可恢复错误）。
 */
function retryActionFor(failureCode?: string): PublicErrorAction {
  return aiFailureAction(failureCode)
}

export class AiTaskManager {
  private flows = new Map<string, AiGenerationFlow>()
  private waiting: string[] = []
  private tickTimer: ReturnType<typeof setTimeout> | null = null
  private ticking = false
  private hidden = false
  private initialized = false
  private taskListeners = new Map<string, Set<AiTaskListener>>()
  private globalListeners = new Set<AiTaskListener>()

  /** App.onLaunch：迁移旧会话 → 清理 → 自愈 → 恢复队列。 */
  init(): void {
    if (this.initialized) return
    this.initialized = true
    pruneAiTasks()
    pruneAiTaskImages()
    migrateLegacyAiSession()

    for (const task of listActiveAiTasks()) {
      const recovered = this.recoverTask(task)
      void this.applyTaskToWorkItem(recovered.taskId)
      if (!isAiTaskTerminal(recovered.status) && this.waiting.length < QUEUE_MAX) {
        this.waiting.push(recovered.taskId)
      }
    }
    this.pumpQueue()
    this.scheduleTimer()
    void this.tick()
    this.notifyAll()
  }

  /** App.onShow：追赶一次（后台期间定时器不可靠）。 */
  onAppShow(): void {
    this.hidden = false
    this.flows.forEach((flow) => flow.wake())
    this.pumpQueue()
    this.scheduleTimer()
    void this.tick()
    this.notifyAll()
  }

  /** App.onHide：停 tick，任务状态保持在本地。 */
  onAppHide(): void {
    this.hidden = true
    if (this.tickTimer !== null) {
      clearTimeout(this.tickTimer)
      this.tickTimer = null
    }
  }

  /** 首页发起：建任务 → 落库占位作品 → 入队 → 立刻返回，不阻塞页面。 */
  async createTask(input: CreateAiTaskInput): Promise<string> {
    if (listActiveAiTasks().length >= QUEUE_MAX) {
      throw new ApiError('生成任务过多，请稍后再试', { code: 'AI_TASK_QUEUE_FULL' })
    }
    const task = createAiTask(input)
    await this.applyTaskToWorkItem(task.taskId)
    this.waiting.push(task.taskId)
    this.pumpQueue()
    this.scheduleTimer()
    void this.tick()
    this.notifyAll()
    return task.taskId
  }

  /** 作品页/详情页重试失败任务。 */
  async retryTask(taskId: string): Promise<void> {
    const task = getAiTask(taskId)
    if (!task || task.status !== 'failed') return
    if (!canRetryTask(task.failure?.code)) {
      wx.showToast({ title: '这个任务无法重试，请重新选图生成', icon: 'none' })
      return
    }
    if (task.retryCount >= MAX_RETRY_COUNT) {
      wx.showToast({ title: '重试次数过多，请重新选图生成', icon: 'none' })
      return
    }
    if (!isFilePathAlive(task.sourceImagePath)) {
      await this.markFailed(taskId, invalidImageFailure())
      return
    }
    // 远端 job 一旦 failed 就是终态：沿用旧 jobId / 旧幂等键重试时，flow 只会走 query
    // 取回同一个失败结果（服务端 create 命中旧幂等键返回 failed 任务），重试按钮形同虚设。
    // 因此重试一律按「新建」处理：换幂等键 + 清 jobId，让它重新走 submit。
    // 服务端对旧幂等键命中的 failed 任务也会重新排队，两处互为兜底。
    const restartFromUpload = !task.inputFileId || !isFilePathAlive(task.inputImagePath ?? task.sourceImagePath)
    patchAiTask(taskId, {
      status: restartFromUpload ? 'created' : 'queued',
      failure: null,
      finishedAt: null,
      retryCount: task.retryCount + 1,
      jobId: null,
      idempotencyKey: createIdempotencyKey(),
    })
    await this.applyTaskToWorkItem(taskId)
    if (!this.waiting.includes(taskId)) this.waiting.push(taskId)
    this.pumpQueue()
    this.scheduleTimer()
    void this.tick()
    this.notifyAll()
  }

  /** 取消并删除：销毁 flow → 删任务 → 删占位作品。后端无取消接口，远端任务自然过期。 */
  async cancelTask(taskId: string): Promise<void> {
    this.flows.get(taskId)?.destroy()
    this.flows.delete(taskId)
    this.waiting = this.waiting.filter((id) => id !== taskId)
    removeAiTask(taskId)
    try {
      await appStore.deleteWork(taskId)
    } catch (error) {
      console.error('删除 AI 任务作品失败', error)
    }
    this.pumpQueue()
    this.scheduleTimer()
    void this.tick()
    this.notifyAll()
  }

  /** 订阅单个任务（详情页用）。 */
  subscribeTask(taskId: string, listener: AiTaskListener): () => void {
    const listeners = this.taskListeners.get(taskId) ?? new Set<AiTaskListener>()
    listeners.add(listener)
    this.taskListeners.set(taskId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.taskListeners.delete(taskId)
    }
  }

  /** 订阅全部任务变化（作品页用）。 */
  subscribeAll(listener: AiTaskListener): () => void {
    this.globalListeners.add(listener)
    return () => this.globalListeners.delete(listener)
  }

  getTaskView(taskId: string): AiTaskView | null {
    const task = getAiTask(taskId)
    if (!task) return null
    return this.buildView(task)
  }

  listTaskViews(): AiTaskView[] {
    return listAiTasks()
      .map((task) => this.buildView(task))
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  /** 详情页缺省 taskId 时回退到最近一个活跃任务；都没有则返回 null（页面据此回首页）。 */
  resolveTaskId(preferred?: string): string | null {
    if (preferred && getAiTask(preferred)) return preferred
    const active = listActiveAiTasks()
    const latest = active[active.length - 1]
    if (latest) return latest.taskId
    const terminal = listAiTasks()
      .filter((task) => isAiTaskTerminal(task.status))
      .sort((left, right) => right.createdAt - left.createdAt)
    return terminal[0]?.taskId ?? null
  }

  private buildView(task: AiTask): AiTaskView {
    const flow = this.flows.get(task.taskId)
    const flowState = flow?.getState()
    const waitingIndex = this.waiting.indexOf(task.taskId)
    const queuePosition = waitingIndex >= 0 ? waitingIndex + 1 : 0
    const failure = task.failure
    const failureCode = failure?.code ?? null

    let stateTitle = flowState?.stateTitle ?? ''
    let stateDescription = flowState?.stateDescription ?? ''
    if (!flowState) {
      const fallback = this.describeTerminal(task)
      stateTitle = fallback.stateTitle
      stateDescription = fallback.stateDescription
    }

    return {
      taskId: task.taskId,
      status: task.status,
      isActive: !isAiTaskTerminal(task.status),
      isFailed: task.status === 'failed',
      isSucceeded: task.status === 'succeeded',
      progress: PHASE_PROGRESS[task.status],
      queuePosition,
      stateTitle,
      stateDescription,
      statusMessage: flowState?.statusMessage ?? '',
      waitingLong: flowState?.waitingLong ?? false,
      failureCode,
      failureMessage: failure ? aiGenerationErrorMessage(failure) : '',
      canRetry: task.status === 'failed' && canRetryTask(failureCode ?? undefined),
      retryLabel: retryActionLabel(failureCode ?? undefined),
      action: flowState?.action ?? failure?.action ?? 'RETRY',
      showPurchase: flowState?.showPurchase ?? failure?.action === 'VIEW_BENEFITS',
      settings: task.settings,
      sourceImagePath: task.sourceImagePath,
      width: task.settings.width,
      height: task.settings.height,
      colorLimit: task.settings.colorLimit,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }
  }

  private describeTerminal(task: AiTask): { stateTitle: string; stateDescription: string } {
    if (task.status === 'succeeded') {
      return { stateTitle: 'AI 生成完成', stateDescription: '图纸已保存到作品，可以开始编辑' }
    }
    if (task.status === 'failed') {
      return {
        stateTitle: 'AI 生成失败',
        stateDescription: task.failure ? aiGenerationErrorMessage(task.failure) : '生成过程发生异常，请重试',
      }
    }
    if (this.waiting.includes(task.taskId)) {
      return { stateTitle: '排队中', stateDescription: '正在等待其他任务让出生成名额' }
    }
    return { stateTitle: '正在继续生成', stateDescription: '正在读取本地任务记录' }
  }

  /** 冷启动自愈：超时判失败、源图失效判失败，其余原样返回。 */
  private recoverTask(task: AiTask): AiTask {
    if (hasTimedOut(task)) {
      patchAiTask(task.taskId, { status: 'failed', failure: timeoutFailure(), finishedAt: Date.now() })
      return getAiTask(task.taskId) ?? task
    }
    if (!isFilePathAlive(task.sourceImagePath)) {
      patchAiTask(task.taskId, { status: 'failed', failure: invalidImageFailure(), finishedAt: Date.now() })
      return getAiTask(task.taskId) ?? task
    }
    return task
  }

  /** 超时/源图失效等由 manager 直接判定的失败：收尾并通知。 */
  private async markFailed(taskId: string, failure: AiGenerationFailure): Promise<void> {
    this.flows.get(taskId)?.destroy()
    this.flows.delete(taskId)
    patchAiTask(taskId, { status: 'failed', failure, finishedAt: Date.now() })
    await this.applyTaskToWorkItem(taskId)
    this.pumpQueue()
    this.scheduleTimer()
    this.notifyAll()
  }

  private pumpQueue(): boolean {
    if (this.hidden) return false
    let started = false
    while (this.flows.size < MAX_CONCURRENT && this.waiting.length > 0) {
      const taskId = this.waiting.shift()
      if (!taskId) break
      const task = getAiTask(taskId)
      if (!task || isAiTaskTerminal(task.status)) continue
      if (!isFilePathAlive(task.sourceImagePath)) {
        void this.markFailed(taskId, invalidImageFailure())
        continue
      }
      this.flows.set(taskId, new AiGenerationFlow({
        taskId,
        onStateChange: (changedId) => void this.handleFlowChange(changedId),
        onDraftReady: (finishedId, draft) => this.finalizeSuccess(finishedId, draft),
      }))
      started = true
    }
    return started
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.hidden) return
    this.ticking = true
    try {
      this.markTimeoutTasks()
      this.pumpQueue()
      const due = [...this.flows.values()].filter((flow) => flow.needsPoll())
      // 串行发起，避免并发打爆服务端，也让 N 个任务共用一次 tick 节奏
      for (const flow of due) {
        if (this.hidden) break
        await flow.pollOnce()
        const task = getAiTask(flow.getTaskId())
        if (!task || isAiTaskTerminal(task.status) || flow.isFinished()) {
          flow.destroy()
          this.flows.delete(flow.getTaskId())
          void this.applyTaskToWorkItem(flow.getTaskId())
        }
      }
      this.pumpQueue()
    } catch (error) {
      console.error('AI 任务调度异常', error)
    } finally {
      this.ticking = false
      this.scheduleTimer()
    }
  }

  private markTimeoutTasks(): void {
    for (const flow of this.flows.values()) {
      const task = getAiTask(flow.getTaskId())
      if (!task || isAiTaskTerminal(task.status)) continue
      if (hasTimedOut(task)) {
        void this.markFailed(task.taskId, timeoutFailure())
      }
    }
  }

  private async handleFlowChange(taskId: string): Promise<void> {
    const task = getAiTask(taskId)
    if (task && isAiTaskTerminal(task.status)) {
      const flow = this.flows.get(taskId)
      if (flow) {
        flow.destroy()
        this.flows.delete(taskId)
      }
    }
    await this.applyTaskToWorkItem(taskId)
    this.notifyAll()
  }

  /**
   * 把任务状态同步到作品记录：占位作品缺失就补写，状态漂移就纠正。
   * 这是「任务」与「作品」唯一的对齐点，避免两边各自演化出不一致。
   */
  private async applyTaskToWorkItem(taskId: string): Promise<void> {
    const task = getAiTask(taskId)
    if (!task) return
    const existing = appStore.getSnapshot().works.find((work) => work.id === taskId)

    if (task.status === 'succeeded') {
      // 成功态由 finalizeSuccess 写好真实计数；这里只兜底清理占位标记
      if (existing && isAiTaskWork(existing)) {
        await appStore.saveWork({
          ...existing,
          status: 'draft',
          failureCode: undefined,
          failureMessage: undefined,
          aiTaskId: taskId,
          updatedAt: Date.now(),
        })
      }
      return
    }

    const desired: WorkStatus = task.status === 'failed' ? 'ai_failed' : 'ai_pending'
    const failureCode = task.failure?.code
    const failureMessage = task.failure ? aiGenerationErrorMessage(task.failure) : undefined

    if (!existing) {
      await appStore.saveWork({
        ...this.buildPendingWork(task),
        status: desired,
        failureCode,
        failureMessage,
      })
      return
    }
    if (existing.status === desired && existing.failureCode === failureCode) return
    await appStore.saveWork({
      ...existing,
      status: desired,
      failureCode,
      failureMessage,
      aiTaskId: taskId,
      updatedAt: Date.now(),
    })
  }

  private buildPendingWork(task: AiTask): WorkItem {
    return {
      id: task.taskId,
      title: DEFAULT_AI_WORK_TITLE,
      coverPath: task.sourceImagePath,
      generationMode: 'ai',
      updatedAt: Date.now(),
      createdAt: task.createdAt,
      beadCount: 0,
      colorCount: task.settings.colorLimit,
      width: task.settings.width,
      height: task.settings.height,
      status: 'ai_pending',
      aiTaskId: task.taskId,
    }
  }

  /** 任务成功：草稿 ID 与作品 ID 一致（都取自 taskId），不抢占 currentDraft。 */
  private async finalizeSuccess(taskId: string, draft: PatternDraft): Promise<void> {
    const task = getAiTask(taskId)
    const existing = appStore.getSnapshot().works.find((work) => work.id === taskId)
    const beadCount = draft.cells.filter((cell) => cell.color !== 'transparent').length
    const colorCount = new Set(
      draft.cells.map((cell) => cell.color).filter((color) => color !== 'transparent'),
    ).size
    try {
      await appStore.saveLocalDraft(draft, false)
      await appStore.saveWork({
        id: taskId,
        title: existing?.title?.trim() || DEFAULT_AI_WORK_TITLE,
        coverPath: draft.sourceImagePath || task?.sourceImagePath || '',
        generationMode: 'ai',
        updatedAt: Date.now(),
        createdAt: existing?.createdAt ?? draft.createdAt,
        beadCount,
        colorCount,
        width: draft.settings.width,
        height: draft.settings.height,
        status: 'draft',
        aiTaskId: taskId,
        failureCode: undefined,
        failureMessage: undefined,
        syncStatus: hasCloudSession() ? 'pending' : 'guest',
      })
      wx.vibrateShort({ type: 'light', fail: () => undefined })
      wx.showToast({ title: 'AI 拼豆图已生成', icon: 'success' })
    } catch (error) {
      console.error('AI 草稿落库失败', error)
      throw error
    }
  }

  private scheduleTimer(): void {
    if (this.hidden) return
    if (this.tickTimer !== null) return
    if (this.flows.size === 0 && this.waiting.length === 0) return
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null
      void this.tick()
    }, TICK_INTERVAL_MS)
  }

  private notifyAll(): void {
    this.globalListeners.forEach((listener) => {
      try {
        listener()
      } catch (error) {
        console.error('AI 任务监听回调执行失败', error)
      }
    })
    this.taskListeners.forEach((listeners, taskId) => {
      if (!listeners.size) return
      listeners.forEach((listener) => {
        try {
          listener()
        } catch (error) {
          console.error('AI 任务监听回调执行失败', taskId, error)
        }
      })
    })
  }
}

/**
 * 单任务超过 15 分钟未出结果即判超时（后端输入输出 24h 过期，这是体感上限）。
 *
 * **计时必须从「真正开始生成」起算，不能含排队时间**：任务可能因为并发槽位占满、
 * 或 App 被切后台而在 created/queued 里等很久，`startedAt` 在首个流转令到达前一直是 null。
 * 若拿 `createdAt` 兜底，冷启动时一个"关了半小时的 App 里刚排上队"的任务会被直接判超时，
 * 用户明明什么都没做错。
 */
function hasTimedOut(task: AiTask): boolean {
  // 还没真正跑起来：按「排队上限」而不是「生成上限」判，避免把正常排队算成超时
  if (!task.startedAt || task.startedAt <= 0) {
    return task.createdAt > 0 && Date.now() - task.createdAt > QUEUE_WAIT_TIMEOUT_MS
  }
  return Date.now() - task.startedAt > TASK_TIMEOUT_MS
}

function timeoutFailure(): AiGenerationFailure {
  return {
    code: 'AI_TIMEOUT',
    message: 'AI 生成超时，请稍后重试',
    category: 'PROVIDER',
    retryable: true,
    action: 'RETRY',
  }
}

function invalidImageFailure(): AiGenerationFailure {
  return {
    code: 'AI_INPUT_FILE_UNAVAILABLE',
    message: '输入图片已失效，请重新选择图片',
    category: 'INPUT',
    retryable: false,
    action: 'SELECT_IMAGE',
  }
}

/** 全局单例，其他模块统一从本导出引用，避免重复创建调度器。 */
export const aiTaskManager = new AiTaskManager()
