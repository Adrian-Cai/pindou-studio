import { type AiGenerationFlowState } from '../../services/ai-generation-flow'
import { DEFAULT_AI_OPTIONS } from '../../services/ai-generation-service'
import { createDraft } from '../../services/image-service'
import { ApiError } from '../../services/http-client'
import { appStore } from '../../store/app-store'
import {
  createIdempotencyKey,
  loadAiGenerationSession,
  saveAiGenerationSession,
} from '../../services/ai-generation-session'
import { aiGenerationManager } from '../../services/ai-generation-manager'

const GENERATING_STATES: ReadonlySet<string> = new Set([
  'uploading',
  'submitting',
  'queued',
  'processing',
  'downloading',
  'converting',
])

/** 各生成阶段展示的近似进度（服务端任务没有精确百分比，用“约 N%”呈现） */
const GENERATING_PROGRESS: Record<string, number> = {
  uploading: 12,
  submitting: 28,
  queued: 45,
  processing: 68,
  downloading: 86,
  converting: 94,
}

const DEFAULT_GENERATING_TIP = '正在为你优化图片细节，生成完成后即可开始编辑'
const LONG_WAIT_TIP = '处理时间比平时长一些，可以暂时离开，稍后回来继续查看'

Page({
  data: {
    pageState: 'loading',
    stateTitle: '正在恢复 AI 任务',
    stateDescription: '正在读取本地任务记录',
    statusMessage: '',
    sourceImagePath: '',
    sourceImageError: false,
    waitingLong: false,
    showPurchase: false,
    retryMode: 'generation',
    retryable: true,
    action: 'RETRY',
    isGenerating: false,
    progress: 0,
    tipText: DEFAULT_GENERATING_TIP,
  },

  onLoad() {
    ensureAiSession()
    aiGenerationManager.attachView({
      onStateChange: (state) => this.applyFlowState(state),
      onSourceImage: (sourceImagePath) => this.setData({ sourceImagePath, sourceImageError: false }),
      onDraftReady: async (draft) => {
        await appStore.setCurrentDraft(draft)
        await redirectToEditor()
      },
    })
  },

  onShow() {
    aiGenerationManager.ensureFlowRunning()
  },

  onHide() {
    aiGenerationManager.detachView()
  },

  onUnload() {
    aiGenerationManager.detachView()
  },

  applyFlowState(state: AiGenerationFlowState) {
    const isGenerating = GENERATING_STATES.has(state.pageState)
    this.setData({
      ...state,
      isGenerating,
      progress: isGenerating ? GENERATING_PROGRESS[state.pageState] ?? 0 : 0,
      tipText: state.statusMessage
        || (state.waitingLong ? LONG_WAIT_TIP : DEFAULT_GENERATING_TIP),
    })
  },

  retry() {
    void aiGenerationManager.retry()
  },

  purchaseAiGeneration() {
    wx.navigateTo({ url: '/packages/payment/recharge/index' })
  },

  async useStandardMode() {
    const session = loadAiGenerationSession()
    if (!session) {
      this.selectNewImage()
      return
    }
    wx.showLoading({ title: '正在切换', mask: true })
    try {
      const draft = await createDraft(session.sourceImagePath, session.settings, 'standard')
      aiGenerationManager.cancelActiveTask()
      await appStore.setCurrentDraft(draft)
      await redirectToEditor()
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '标准模式生成失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  selectNewImage() {
    aiGenerationManager.cancelActiveTask()
    wx.switchTab({ url: '/pages/home/index' })
  },

  backHome() {
    wx.switchTab({ url: '/pages/home/index' })
  },

  handleImageError() {
    this.setData({ sourceImageError: true })
  },
})

function redirectToEditor(): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.redirectTo({
      url: '/packages/editor/index',
      success: () => resolve(),
      fail: () => reject(new ApiError('编辑器打开失败，请稍后重试', { code: 'NAVIGATION_ERROR' })),
    })
  })
}

function ensureAiSession(): void {
  const draft = appStore.getSnapshot().currentDraft
  if (!draft?.id.startsWith('ai-pending-')) return
  const existing = loadAiGenerationSession()
  if (existing?.sourceImagePath === draft.sourceImagePath && existing.status !== 'failed') {
    if (existing.inputFileId || existing.jobId) return
    try {
      saveAiGenerationSession({
        ...existing,
        securityCheckId: draft.contentSecurityCheckId,
        inputImagePath: draft.contentSecurityImagePath,
      })
    } catch (error) {
      console.error('更新 AI 任务会话失败', error)
    }
    return
  }
  try {
    saveAiGenerationSession({
      idempotencyKey: createIdempotencyKey(),
      generationMode: 'ai',
      jobId: null,
      inputFileId: null,
      securityCheckId: draft.contentSecurityCheckId,
      inputImagePath: draft.contentSecurityImagePath,
      sourceImagePath: draft.sourceImagePath,
      outputImagePath: '',
      settings: { ...draft.settings },
      ...DEFAULT_AI_OPTIONS,
      status: 'uploading',
      createdAt: Date.now(),
    })
  } catch (error) {
    console.error('创建 AI 任务会话失败', error)
  }
}
