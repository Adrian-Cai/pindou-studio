import {
  AiGenerationFlow,
  type AiGenerationFlowState,
} from './services/ai-generation-flow'
import { createDraft } from '../../services/image-service'
import { ApiError } from '../../services/http-client'
import { appStore } from '../../store/app-store'
import { clearAiGenerationSession, loadAiGenerationSession } from '../../services/ai-generation-session'

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
  },

  _aiFlow: null as AiGenerationFlow | null,

  onLoad() {
    this._aiFlow = new AiGenerationFlow({
      onStateChange: (state) => this.applyFlowState(state),
      onSourceImage: (sourceImagePath) => this.setData({ sourceImagePath, sourceImageError: false }),
      onDraftReady: async (draft) => {
        await appStore.setCurrentDraft(draft)
        await redirectToEditor()
      },
    })
  },

  onShow() {
    this._aiFlow?.onShow()
  },

  onHide() {
    this._aiFlow?.onHide()
  },

  onUnload() {
    this._aiFlow?.destroy()
  },

  applyFlowState(state: AiGenerationFlowState) {
    this.setData({ ...state })
  },

  retry() {
    void this._aiFlow?.retry()
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
      clearAiGenerationSession()
      await appStore.setCurrentDraft(draft)
      await redirectToEditor()
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '标准模式生成失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  selectNewImage() {
    clearAiGenerationSession()
    wx.switchTab({ url: '/pages/home/index' })
  },

  backHome() {
    this._aiFlow?.onHide()
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
