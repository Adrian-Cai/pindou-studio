import {
  createDraft,
  persistImage,
  prepareImageForContentSecurity,
  stripAiWatermarkBand,
} from './image-service'
import {
  aiGenerationFailure,
  aiGenerationErrorMessage,
  createAiGeneration,
  downloadAiOutput,
  getAiGeneration,
  isAiOutputImageAvailable,
  uploadAiInput,
  type AiGeneration,
  type AiGenerationFailure,
} from './ai-generation-service'
import {
  getAiTask,
  isAiTaskTerminal,
  isFilePathAlive,
  patchAiTask,
  type AiTask,
  type AiTaskStatus,
} from './ai-task-store'
import { ApiError, type PublicErrorAction } from './http-client'
import type { PatternDraft } from '../models/pattern'

export type AiGenerationFlowPageState =
  | 'waiting'
  | 'uploading'
  | 'submitting'
  | 'queued'
  | 'processing'
  | 'downloading'
  | 'converting'
  | 'succeeded'
  | 'failed'

export type AiGenerationFlowRetryMode = 'generation' | 'query' | 'download' | 'converting'

export interface AiGenerationFlowState {
  pageState: AiGenerationFlowPageState
  stateTitle: string
  stateDescription: string
  statusMessage: string
  waitingLong: boolean
  retryMode: AiGenerationFlowRetryMode
  showPurchase: boolean
  retryable: boolean
  action: PublicErrorAction
}

/** 单个任务的驱动选项：任务 ID + 状态变更回调；草稿由 manager 统一落库。 */
export interface AiGenerationFlowOptions {
  taskId: string
  onStateChange: (taskId: string) => void
  onDraftReady?: (taskId: string, draft: PatternDraft) => Promise<void>
}

const POLL_INTERVAL_MS = 4_000
const LONG_WAIT_MS = 60_000
const NETWORK_BACKOFF_MS = [8_000, 15_000, 30_000] as const
/** 撞限流后的排队退避：比网络退避更长，给服务端限流窗口留出恢复时间 */
const RATE_LIMIT_BACKOFF_MS = [15_000, 30_000, 60_000] as const
const MAX_RATE_LIMIT_RETRIES = RATE_LIMIT_BACKOFF_MS.length

/**
 * 单条 AI 任务的执行器：负责「上传 → 创建 → 轮询 → 下载 → 转网格」这一条链。
 *
 * 一个实例只绑定一个 taskId，所有状态只读写自己那一条 AiTask，
 * 因此多条任务可以并存，互不覆盖（旧方案的单例 session 正是被新任务覆盖才导致永久加载）。
 * 自身不持有任何定时器：什么时候该动由 `needsPoll()` 告诉 AiTaskManager，
 * 由 manager 的单个 tick 串行驱动，避免每个任务各起一个 setTimeout。
 *
 * 注意：本文件必须位于主包，app.ts 启动时会通过 ai-generation-manager 引用，
 * 放在分包内会导致主包无法 require。
 */
export class AiGenerationFlow {
  private readonly taskId: string
  private readonly options: AiGenerationFlowOptions

  private state: AiGenerationFlowState = {
    pageState: 'waiting',
    stateTitle: '正在恢复 AI 任务',
    stateDescription: '正在读取本地任务记录',
    statusMessage: '',
    waitingLong: false,
    retryMode: 'generation',
    showPurchase: false,
    retryable: true,
    action: 'RETRY',
  }

  private busy = false
  private destroyed = false
  private finished = false
  private nextPollAt: number | null = null
  private networkFailureCount = 0
  private rateLimitCount = 0
  private processingSince: number | null = null

  constructor(options: AiGenerationFlowOptions) {
    this.taskId = options.taskId
    this.options = options
    this.resetStateFromTask()
  }

  getTaskId(): string {
    return this.taskId
  }

  getState(): AiGenerationFlowState {
    const waitingLong = this.processingSince !== null && Date.now() - this.processingSince > LONG_WAIT_MS
    return { ...this.state, waitingLong }
  }

  isFinished(): boolean {
    return this.finished
  }

  /** 是否需要被 tick 驱动一次：未在请求中、未终态、已到下一次轮询时间。 */
  needsPoll(): boolean {
    if (this.destroyed || this.finished || this.busy) return false
    return this.nextPollAt !== null && Date.now() >= this.nextPollAt
  }

  /** App 回到前台时的追赶：后台定时器不可靠，强制把下一次轮询拉到当下。 */
  wake(): void {
    if (this.destroyed || this.finished || this.busy) return
    if (this.nextPollAt === null) this.nextPollAt = Date.now()
    else this.nextPollAt = Math.min(this.nextPollAt, Date.now())
  }

  /**
   * 推进一次任务。具体做什么由持久化的任务状态决定，
   * 因此冷启动恢复、切后台回来、普通轮询走的是同一条路径。
   */
  async pollOnce(): Promise<void> {
    if (this.busy || this.destroyed || this.finished) return
    this.busy = true
    this.nextPollAt = null
    try {
      const task = getAiTask(this.taskId)
      if (!task) {
        this.setFailure('没有找到可恢复的 AI 任务，请返回首页重新开始', 'generation', null)
        return
      }
      if (isAiTaskTerminal(task.status)) {
        this.syncTerminalState(task)
        return
      }
      if (!task.jobId) {
        await this.submit(task)
        return
      }
      await this.query(task)
    } catch (error) {
      if (this.destroyed) return
      this.setFailure(aiGenerationErrorMessage(error), 'generation', aiGenerationFailure(error))
    } finally {
      this.busy = false
    }
  }

  /** 彻底销毁流程（任务取消时调用），后续 tick 不再驱动它。 */
  destroy(): void {
    this.destroyed = true
    this.finished = true
    this.nextPollAt = null
  }

  /** 从持久化的任务状态重建 UI 状态，并决定是否需要继续推进。 */
  private resetStateFromTask(): void {
    const task = getAiTask(this.taskId)
    if (!task) {
      this.nextPollAt = null
      this.finished = true
      return
    }
    this.applyTaskStatus(task)
    if (isAiTaskTerminal(task.status)) {
      this.finished = true
      this.nextPollAt = null
      return
    }
    this.nextPollAt = Date.now()
  }

  private syncTerminalState(task: AiTask): void {
    this.applyTaskStatus(task)
    this.finished = true
    this.nextPollAt = null
  }

  private applyTaskStatus(task: AiTask): void {
    const description = describeStatus(task.status)
    this.state = {
      ...this.state,
      pageState: description.pageState,
      stateTitle: description.stateTitle,
      stateDescription: description.stateDescription,
      waitingLong: false,
    }
    if (task.status === 'queued' || task.status === 'processing') {
      this.processingSince = task.startedAt ?? Date.now()
    }
    if (task.status === 'failed') {
      this.applyFailure(task.failure)
    }
  }

  /** 提交任务：缺 inputFileId 先上传，随后用幂等键创建远端任务。 */
  private async submit(task: AiTask): Promise<void> {
    let inputFileId = task.inputFileId
    if (!inputFileId) {
      if (!isFilePathAlive(task.sourceImagePath)) {
        throw new ApiError('输入图片已失效，请重新选择图片', { code: 'AI_INPUT_FILE_UNAVAILABLE' })
      }
      this.transition('uploading', 'generation')
      patchAiTask(this.taskId, { status: 'uploading' })
      const inputImagePath = task.inputImagePath && isFilePathAlive(task.inputImagePath)
        ? task.inputImagePath
        : await prepareImageForContentSecurity(task.sourceImagePath)
      const uploaded = await uploadAiInput(inputImagePath, task.securityCheckId)
      // await 期间任务可能已被取消：这里不 return 的话，后面的 patchAiTask 会把
      // 已取消的任务重新写成 submitting/queued，卡片「复活」且再也收不到终态。
      if (this.destroyed) return
      inputFileId = uploaded.id
      patchAiTask(this.taskId, { inputFileId, inputImagePath })
    }

    this.transition('submitting', 'generation')
    patchAiTask(this.taskId, { status: 'submitting' })
    let generation: AiGeneration
    try {
      generation = await createAiGeneration({
        inputFileId,
        style: task.style,
        detailLevel: task.detailLevel,
        backgroundMode: task.backgroundMode,
        idempotencyKey: task.idempotencyKey,
      })
    } catch (error) {
      // 撞限流不算失败：排队稍后重试，且必须复用同一个幂等键，避免重试时被重复扣次数
      if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
        this.handleRateLimited()
        return
      }
      throw error
    }
    // 同上：createAiGeneration 耗时可能跨过取消动作，拿到结果也得先确认任务还活着
    if (this.destroyed) return
    patchAiTask(this.taskId, {
      jobId: generation.id,
      status: generation.status === 'succeeded' ? 'succeeded' : 'queued',
      startedAt: Date.now(),
    })
    await this.handleGeneration(generation)
  }

  /** 查询远端任务最新状态；网络异常走退避重试，不直接判失败。 */
  private async query(task: AiTask): Promise<void> {
    const jobId = task.jobId
    if (!jobId) return
    try {
      const generation = await getAiGeneration(jobId)
      if (this.destroyed) return
      this.networkFailureCount = 0
      await this.handleGeneration(generation)
    } catch (error) {
      if (this.destroyed) return
      if (error instanceof ApiError && error.code === 'NETWORK_ERROR') {
        this.networkFailureCount += 1
        this.transition('processing', 'query')
        this.updateState({ statusMessage: '网络暂时不可用，正在稍后重试' })
        this.nextPollAt = Date.now() + this.networkBackoff()
        return
      }
      this.setFailure(aiGenerationErrorMessage(error), 'query', aiGenerationFailure(error))
    }
  }

  /** 根据查询结果做状态迁移：排队/处理中则继续轮询；失败/取消则报错；成功则进入下载+转换。 */
  private async handleGeneration(generation: AiGeneration): Promise<void> {
    if (generation.status === 'queued' || generation.status === 'processing') {
      patchAiTask(this.taskId, {
        status: generation.status === 'queued' ? 'queued' : 'processing',
        startedAt: Date.now(),
      })
      this.transition(generation.status === 'queued' ? 'queued' : 'processing', 'generation')
      this.nextPollAt = Date.now() + POLL_INTERVAL_MS
      return
    }

    if (generation.status === 'failed' || generation.status === 'canceled') {
      const failure = generation.status === 'canceled'
        ? canceledFailure()
        : generation.failure ?? aiGenerationFailure(generation)
      this.failTask(failure)
      return
    }

    await this.completeGeneration(generation)
  }

  /** 远端成功后的收尾：下载产物（已下载则复用）→ 永久化 → 标准图案引擎转换 → 回调 manager 落库。 */
  private async completeGeneration(generation: AiGeneration): Promise<void> {
    if (!generation.outputFile) {
      this.failTask({
        code: 'AI_RESULT_INVALID',
        message: 'AI 生成结果不可用，请重新生成',
        category: 'PROVIDER',
        retryable: true,
        action: 'RETRY',
      })
      return
    }
    const task = getAiTask(this.taskId)
    if (!task) return

    try {
      await this.completeGenerationSteps(generation.outputFile.url, task)
    } catch (error) {
      if (this.destroyed) return
      // 网络/产物损坏走下载重试；其余（转换失败等）走转换重试
      const retryMode: AiGenerationFlowRetryMode = error instanceof ApiError
        && (error.code === 'NETWORK_ERROR' || error.code === 'AI_OUTPUT_INVALID')
        ? 'download'
        : 'converting'
      this.setFailure(aiGenerationErrorMessage(error), retryMode, aiGenerationFailure(error))
    }
  }

  private async completeGenerationSteps(outputUrl: string, task: AiTask): Promise<void> {
    let outputImagePath = task.outputImagePath
    if (!outputImagePath || !(await isAiOutputImageAvailable(outputImagePath))) {
      this.transition('downloading', 'download')
      patchAiTask(this.taskId, { status: 'downloading' })
      // 平台把「AI生成」标识同步烙在产物底部，先裁掉再落盘：图案引擎是按像素降采样
      // 出格子的，不裁的话这几个字会被采样成一格格珠子混进图纸与材料清单。
      // 裁切放在下载这一步，保证一个任务只裁一次——重试/恢复读到的都已是裁好的图。
      outputImagePath = await persistImage(
        await stripAiWatermarkBand(await downloadAiOutput(outputUrl)),
      )
      patchAiTask(this.taskId, { outputImagePath })
    }

    this.transition('converting', 'converting')
    patchAiTask(this.taskId, { status: 'converting' })
    const draft = await createDraft(outputImagePath, task.settings, 'ai', { id: this.taskId })
    if (this.destroyed) return

    // 先让 manager 把草稿与作品落库，再判定任务成功——否则会出现“作品没存下来但任务已成功”
    if (this.options.onDraftReady) {
      await this.options.onDraftReady(this.taskId, draft)
    }
    patchAiTask(this.taskId, { status: 'succeeded', finishedAt: Date.now(), failure: null })
    this.applyTaskStatus(getAiTask(this.taskId) ?? task)
    this.finished = true
    this.nextPollAt = null
    this.notifyChange()
  }

  /**
   * 撞到服务端限流：不判失败，按退避把任务放回队列稍后重试。
   * 幂等键保持不变 —— 换了键重试有被重复扣次数的风险。
   */
  private handleRateLimited(): void {
    this.rateLimitCount += 1
    if (this.rateLimitCount > MAX_RATE_LIMIT_RETRIES) {
      this.setFailure('请求过于频繁，请稍后重试', 'generation', {
        code: 'RATE_LIMITED',
        message: '请求过于频繁，请稍后重试',
        category: 'PROVIDER',
        retryable: true,
        action: 'RETRY',
      })
      return
    }
    this.transition('submitting', 'generation')
    this.updateState({ statusMessage: '生成请求较多，正在排队重试' })
    this.nextPollAt = Date.now() + RATE_LIMIT_BACKOFF_MS[this.rateLimitCount - 1]
  }

  /** 切到其他阶段：更新本地 UI 文案并通知订阅者。 */
  private transition(status: AiTaskStatus, retryMode: AiGenerationFlowRetryMode): void {
    const description = describeStatus(status)
    this.state = {
      ...this.state,
      pageState: description.pageState,
      stateTitle: description.stateTitle,
      stateDescription: description.stateDescription,
      statusMessage: '',
      retryMode,
    }
    if (status === 'queued' || status === 'processing') {
      this.processingSince = this.processingSince ?? Date.now()
    }
    this.notifyChange()
  }

  private failTask(failure: AiGenerationFailure | null): void {
    patchAiTask(this.taskId, {
      status: 'failed',
      failure,
      finishedAt: Date.now(),
    })
    const task = getAiTask(this.taskId)
    this.applyTaskStatus(task ?? { status: 'failed' } as AiTask)
    this.finished = true
    this.nextPollAt = null
    this.notifyChange()
  }

  /** 进入失败态：按 failure 的 action/retryable 决定展示「重试/买次数/切标准模式」。 */
  private setFailure(
    message: string,
    retryMode: AiGenerationFlowRetryMode,
    failure: AiGenerationFailure | null,
  ): void {
    const resolvedFailure = failure ?? aiGenerationFailure({ errorCode: 'AI_GENERATION_FAILED' })
    this.failTask(resolvedFailure)
    if (!resolvedFailure) return
    const action = resolvedFailure.action
    const retryable = resolvedFailure.retryable && action === 'RETRY'
    let stateTitle: string
    if (retryMode === 'converting') {
      stateTitle = '拼豆图生成失败'
    } else if (action === 'USE_STANDARD_MODE') {
      stateTitle = 'AI 生成暂时不可用'
    } else {
      stateTitle = 'AI 生成失败'
    }
    this.state = {
      ...this.state,
      pageState: 'failed',
      stateTitle,
      stateDescription: message,
      statusMessage: '',
      retryMode,
      showPurchase: action === 'VIEW_BENEFITS',
      retryable,
      action,
      waitingLong: false,
    }
    this.notifyChange()
  }

  private applyFailure(failure: AiGenerationFailure | null): void {
    if (!failure) {
      this.state = { ...this.state, action: 'RETRY', retryable: false, showPurchase: false }
      return
    }
    const action = failure.action
    this.state = {
      ...this.state,
      action,
      retryable: failure.retryable && action === 'RETRY',
      showPurchase: action === 'VIEW_BENEFITS',
    }
    if (failure.message) this.state = { ...this.state, stateDescription: failure.message }
  }

  private networkBackoff(): number {
    return NETWORK_BACKOFF_MS[Math.min(this.networkFailureCount - 1, NETWORK_BACKOFF_MS.length - 1)] ?? POLL_INTERVAL_MS
  }

  private updateState(next: Partial<AiGenerationFlowState>): void {
    this.state = { ...this.state, ...next }
    this.notifyChange()
  }

  private notifyChange(): void {
    this.options.onStateChange(this.taskId)
  }
}

function describeStatus(status: AiTaskStatus): {
  pageState: AiGenerationFlowPageState
  stateTitle: string
  stateDescription: string
} {
  switch (status) {
    case 'created':
      return { pageState: 'waiting', stateTitle: '任务排队中', stateDescription: '正在等待其他任务让出生成名额' }
    case 'uploading':
      return { pageState: 'uploading', stateTitle: '正在上传图片', stateDescription: '正在准备 AI 输入图片' }
    case 'submitting':
      return { pageState: 'submitting', stateTitle: '正在创建 AI 任务', stateDescription: '正在提交生成请求' }
    case 'queued':
      return { pageState: 'queued', stateTitle: '任务已排队', stateDescription: '正在等待 AI 开始处理' }
    case 'processing':
      return { pageState: 'processing', stateTitle: 'AI 正在优化图片', stateDescription: '图片完成优化后将继续生成拼豆图' }
    case 'downloading':
      return { pageState: 'downloading', stateTitle: '正在获取生成结果', stateDescription: '正在读取 AI 优化图片' }
    case 'converting':
      return { pageState: 'converting', stateTitle: '正在生成拼豆图', stateDescription: 'AI 优化完成，正在使用标准图案引擎生成网格' }
    case 'succeeded':
      return { pageState: 'succeeded', stateTitle: 'AI 生成完成', stateDescription: '图纸已保存到作品，可以开始编辑' }
    case 'failed':
    default:
      return { pageState: 'failed', stateTitle: 'AI 生成失败', stateDescription: '生成过程发生异常，请重试' }
  }
}

function canceledFailure(): AiGenerationFailure {
  return {
    code: 'AI_GENERATION_FAILED',
    message: '任务已结束，请重新生成',
    category: 'INTERNAL',
    retryable: true,
    action: 'RETRY',
  }
}
