import {
  AiGenerationFlow,
  type AiGenerationFlowState,
} from '../services/ai-generation-flow'
import { ApiError } from '../../services/http-client'
import { appStore } from '../../store/app-store'

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
    wx.navigateTo({ url: '/pages-sub/recharge/index' })
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
      url: '/pages-sub/editor/index',
      success: () => resolve(),
      fail: () => reject(new ApiError('编辑器打开失败，请稍后重试', { code: 'NAVIGATION_ERROR' })),
    })
  })
}
