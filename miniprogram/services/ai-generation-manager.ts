/**
 * AI 生成全局单例任务管理器：让 AI 生成任务在用户离开页面后仍能后台继续轮询直到完成。
 *
 * 职责：持有唯一的 AiGenerationFlow 实例，向页面暴露 attachView/detachView/retry/cancel 等控制；
 *       当页面未挂载（无 viewCallbacks）时，任务成功后自动把草稿落库到本地作品库。
 *       不负责具体网络请求与状态机（见 ai-generation-flow），也不负责响应解析（见 ai-generation-parser）。
 * 调用方：app.ts 启动时 init() 恢复上次未完成任务；AI 生成页 packages/ai-generation 通过 attachView 接管状态展示。
 * 关键点：单例保证全局只有一条生成流程；allowBackground 控制切后台时是否继续轮询——
 *       页面 onHide 会 detachView，但 manager 仍持有 flow，任务可在后台跑完。
 */
import {
  AiGenerationFlow,
  type AiGenerationFlowCallbacks,
} from './ai-generation-flow'
import {
  clearAiGenerationSession,
  loadAiGenerationSession,
  type AiGenerationSession,
} from './ai-generation-session'
import { appStore } from '../store/app-store'
import { hasCloudSession } from './work-service'
import type { PatternDraft, WorkItem } from '../models/pattern'

export interface ActiveAiTaskSummary {
  jobId: string | null
  status: AiGenerationSession['status']
  sourceImagePath: string
  width: number
  height: number
  colorLimit: number
  createdAt: number
  stateTitle: string
  isFailed: boolean
  isProcessing: boolean
}

type TaskListener = () => void

export class AiGenerationManager {
  private flow: AiGenerationFlow | null = null
  private viewCallbacks: AiGenerationFlowCallbacks | null = null
  private listeners = new Set<TaskListener>()

  init(): void {
    const session = loadAiGenerationSession()
    if (session && session.status !== 'failed') {
      this.ensureFlowRunning()
    }
  }

  ensureFlowRunning(): void {
    if (this.flow) return
    const session = loadAiGenerationSession()
    if (!session || session.status === 'failed') return

    this.flow = new AiGenerationFlow({
      allowBackground: true,
      onStateChange: (state) => {
        this.viewCallbacks?.onStateChange(state)
        this.notifyListeners()
      },
      onSourceImage: (sourceImagePath) => {
        this.viewCallbacks?.onSourceImage?.(sourceImagePath)
      },
      onDraftReady: async (draft) => {
        if (this.viewCallbacks) {
          await this.viewCallbacks.onDraftReady(draft)
        } else {
          await this.saveBackgroundDraft(draft)
        }
        this.flow = null
        this.notifyListeners()
      },
    })
    this.flow.start()
  }

  attachView(callbacks: AiGenerationFlowCallbacks): void {
    this.viewCallbacks = callbacks
    this.ensureFlowRunning()
    if (this.flow) {
      this.flow.attachView(callbacks)
    } else {
      const session = loadAiGenerationSession()
      if (session) {
        if (session.status === 'failed') {
          callbacks.onStateChange({
            pageState: 'failed',
            stateTitle: 'AI 生成失败',
            stateDescription: '生成过程发生异常，请重试',
            statusMessage: '',
            waitingLong: false,
            retryMode: 'generation',
            showPurchase: false,
            retryable: true,
            action: 'RETRY',
          })
        }
        callbacks.onSourceImage?.(session.sourceImagePath)
      }
    }
  }

  detachView(): void {
    this.viewCallbacks = null
  }

  async retry(): Promise<void> {
    if (!this.flow) {
      this.ensureFlowRunning()
    }
    if (this.flow) {
      await this.flow.retry()
    }
  }

  cancelActiveTask(): void {
    if (this.flow) {
      this.flow.destroy()
      this.flow = null
    }
    clearAiGenerationSession()
    this.notifyListeners()
  }

  getActiveTask(): ActiveAiTaskSummary | null {
    const session = loadAiGenerationSession()
    if (!session) return null

    const flowState = this.flow?.getState()
    const isFailed = session.status === 'failed' || flowState?.pageState === 'failed'
    // 非失败即视为进行中（用于列表里展示“生成中”态）
    const isProcessing = !isFailed

    let stateTitle = 'AI 正在生成'
    if (isFailed) {
      stateTitle = 'AI 生成失败'
    } else if (flowState?.stateTitle) {
      stateTitle = flowState.stateTitle
    } else if (session.status === 'uploading') {
      stateTitle = '正在上传图片'
    } else if (session.status === 'creating') {
      stateTitle = '正在创建 AI 任务'
    } else if (session.status === 'processing') {
      stateTitle = 'AI 正在处理'
    }

    return {
      jobId: session.jobId,
      status: session.status,
      sourceImagePath: session.sourceImagePath,
      width: session.settings.width,
      height: session.settings.height,
      colorLimit: session.settings.colorLimit,
      createdAt: session.createdAt,
      stateTitle,
      isFailed,
      isProcessing,
    }
  }

  subscribe(listener: TaskListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notifyListeners(): void {
    this.listeners.forEach((listener) => {
      try {
        listener()
      } catch (error) {
        console.error('AI 任务监听回调执行失败', error)
      }
    })
  }

  private async saveBackgroundDraft(draft: PatternDraft): Promise<void> {
    const session = loadAiGenerationSession()
    const coverPath = session?.sourceImagePath || draft.sourceImagePath
    const now = Date.now()
    const beadCount = draft.cells.filter((cell) => cell.color !== 'transparent').length
    const colorCount = new Set(draft.cells.map((cell) => cell.color).filter((color) => color !== 'transparent')).size

    const workItem: WorkItem = {
      id: draft.id,
      title: 'AI 拼豆草稿',
      coverPath,
      generationMode: 'ai',
      updatedAt: now,
      createdAt: draft.createdAt || now,
      beadCount,
      colorCount,
      width: draft.settings.width,
      height: draft.settings.height,
      status: 'draft',
      syncStatus: hasCloudSession() ? 'pending' : 'guest',
      isCloud: false,
    }

    try {
      await appStore.saveLocalDraft(draft, false)
      await appStore.saveWork(workItem)
      clearAiGenerationSession()
      wx.showToast({ title: 'AI 拼豆图已生成完成', icon: 'success' })
    } catch (error) {
      console.error('后台 AI 草稿作品保存失败', error)
    }
  }
}

/** 全局单例，其他模块统一从本导出引用，避免重复创建流程。 */
export const aiGenerationManager = new AiGenerationManager()
