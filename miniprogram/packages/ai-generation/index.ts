/**
 * AI 任务详情页（分包 packages/ai-generation）：展示某一条 AI 生成任务的状态并提供操作。
 *
 * 职责：通过 `?taskId=` 绑定具体任务，把 AiTaskView 映射成页面 UI
 *       （排队中 / 生成中 / 已完成 / 失败），提供取消、重试、购买次数、切标准模式、查看作品等操作。
 * 调用方：作品页点 pending/failed 卡片（`?taskId=&from=projects`）、
 *        AI 生成完成后的一次性跳转（`?taskId=&from=home`）。
 * 关键点：页面只订阅不驱动——onHide/onUnload 仅退订，任务照常在后台跑；
 *        `from=home` 表示用户刚发起，成功后自动进编辑器；`from=projects` 表示回看，成功后不跳转。
 */
import { aiTaskManager, type AiTaskView } from '../../services/ai-generation-manager'
import type { AiTaskStatus } from '../../services/ai-task-store'
import { createDraft } from '../../services/image-service'
import { appStore } from '../../store/app-store'

type TaskFrom = 'home' | 'projects'

const GENERATING_STATUSES: ReadonlySet<AiTaskStatus> = new Set<AiTaskStatus>([
  'uploading',
  'submitting',
  'queued',
  'processing',
  'downloading',
  'converting',
])

const DEFAULT_TIP = '正在为你优化图片细节，生成完成后即可开始编辑'
const LONG_WAIT_TIP = '处理时间比平时长一些，可以暂时离开，稍后回来继续查看'

Page({
  data: {
    selectedTab: 0,
    hasTask: false,
    sourceImagePath: '',
    sourceImageError: false,
    dimensions: '',
    colorLimit: 0,
    submittedAtText: '',
    isQueued: false,
    isGenerating: false,
    isSucceeded: false,
    isFailed: false,
    progress: 0,
    queuePosition: 0,
    stateTitle: '',
    stateDescription: '',
    statusMessage: '',
    failureMessage: '',
    tipText: DEFAULT_TIP,
    showPurchase: false,
    canRetry: false,
    retryLabel: '重试',
    action: 'RETRY',
    /** 生成中底部面板预填的图案参数（取自任务设置） */
    panelWidth: 0,
    panelHeight: 0,
    panelColorLimit: 0,
    panelBeadCount: 0,
  },

  _taskId: '',
  _from: 'home' as TaskFrom,
  _unsubscribe: null as (() => void) | null,
  _navigated: false,

  onLoad(query?: Record<string, string | undefined>) {
    const from: TaskFrom = query?.from === 'projects' ? 'projects' : 'home'
    // 没带 taskId 时回退到最近一个任务；都没有就直接回首页，不再出现「无任务却停在生成页」
    const taskId = aiTaskManager.resolveTaskId(query?.taskId)
    if (!taskId) {
      wx.showToast({ title: '没有进行中的 AI 任务', icon: 'none' })
      wx.switchTab({ url: '/pages/home/index' })
      return
    }
    this._taskId = taskId
    this._from = from
    this.setData({
      selectedTab: from === 'projects' ? 1 : 0,
    })
    this.subscribe()
  },

  onShow() {
    if (!this._taskId) return
    this._navigated = false
    if (!this._unsubscribe) this.subscribe()
    // 后台回来状态可能已变，重新拉一次快照
    this.syncTask()
  },

  onHide() {
    this.unsubscribe()
  },

  onUnload() {
    this.unsubscribe()
  },

  subscribe() {
    const taskId = this._taskId
    if (!taskId) return
    this.unsubscribe()
    this._unsubscribe = aiTaskManager.subscribeTask(taskId, () => this.syncTask())
  },

  unsubscribe() {
    this._unsubscribe?.()
    this._unsubscribe = null
  },

  syncTask() {
    const taskId = this._taskId
    if (!taskId) return
    const view = aiTaskManager.getTaskView(taskId)
    if (!view) {
      // 任务记录已消失（用户在别处取消了）：别卡在详情页
      this.unsubscribe()
      wx.showToast({ title: '这个任务已不存在', icon: 'none' })
      this.goBack()
      return
    }
    this.applyView(view)
    if (view.isSucceeded) void this.handleSucceeded()
  },

  applyView(view: AiTaskView) {
    const isGenerating = GENERATING_STATUSES.has(view.status)
    const isFailed = view.isFailed
    const isSucceeded = view.isSucceeded
    const isQueued = !isGenerating && !isFailed && !isSucceeded
    this.setData({
      hasTask: true,
      sourceImagePath: view.sourceImagePath,
      sourceImageError: false,
      dimensions: `${view.width}×${view.height}`,
      colorLimit: view.colorLimit,
      submittedAtText: `${formatDateTime(view.createdAt)} 提交`,
      isQueued,
      isGenerating,
      isSucceeded,
      isFailed,
      progress: view.progress,
      queuePosition: view.queuePosition,
      stateTitle: view.stateTitle,
      stateDescription: view.stateDescription,
      statusMessage: view.statusMessage,
      failureMessage: view.failureMessage,
      tipText: view.statusMessage || (view.waitingLong ? LONG_WAIT_TIP : DEFAULT_TIP),
      showPurchase: view.showPurchase,
      canRetry: view.canRetry,
      retryLabel: view.retryLabel,
      action: view.action,
      panelWidth: view.width,
      panelHeight: view.height,
      panelColorLimit: view.colorLimit,
      // 图案尚未生成，颗粒数按满格（宽×高）预估展示
      panelBeadCount: view.width * view.height,
    })
  },

  /** 成功后只在「刚发起」时自动进编辑器；回看时不抢走用户当前页面。 */
  async handleSucceeded() {
    if (this._from !== 'home' || this._navigated) return
    const draft = appStore.getLocalDraft(this._taskId)
    if (!draft) return
    this._navigated = true
    try {
      await appStore.setCurrentDraft(draft)
    } catch (error) {
      console.error('设置当前草稿失败', error)
    }
    wx.redirectTo({ url: '/packages/editor/index' })
  },

  cancelTask() {
    const taskId = this._taskId
    if (!taskId) return
    wx.showModal({
      title: '取消生成？',
      content: '取消后这条任务会从作品列表移除，需要重新选图生成。',
      cancelText: '继续生成',
      confirmText: '取消生成',
      confirmColor: '#e5484d',
      success: ({ confirm }) => {
        if (!confirm) return
        void aiTaskManager.cancelTask(taskId).then(() => {
          this.unsubscribe()
          this.goBack()
        })
      },
    })
  },

  retry() {
    const taskId = this._taskId
    if (!taskId) return
    void aiTaskManager.retryTask(taskId).then(() => this.syncTask())
  },

  async viewWork() {
    const draft = appStore.getLocalDraft(this._taskId)
    if (!draft) {
      wx.showToast({ title: '作品数据尚未就绪，请稍后重试', icon: 'none' })
      return
    }
    try {
      await appStore.setCurrentDraft(draft)
    } catch (error) {
      console.error('设置当前草稿失败', error)
    }
    wx.redirectTo({ url: '/packages/result/index' })
  },

  purchaseAiGeneration() {
    wx.navigateTo({ url: '/packages/payment/recharge/index' })
  },

  async useStandardMode() {
    const view = aiTaskManager.getTaskView(this._taskId)
    if (!view) {
      this.selectNewImage()
      return
    }
    wx.showLoading({ title: '正在切换', mask: true })
    try {
      const draft = await createDraft(view.sourceImagePath, view.settings, 'standard')
      // 放弃这条 AI 任务，改用标准模式生成的草稿
      await aiTaskManager.cancelTask(this._taskId)
      await appStore.setCurrentDraft(draft)
      wx.redirectTo({ url: '/packages/editor/index' })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '标准模式生成失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  selectNewImage() {
    void aiTaskManager.cancelTask(this._taskId)
    wx.switchTab({ url: '/pages/home/index' })
  },

  goBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({
        url: this._from === 'projects' ? '/pages/projects/index' : '/pages/home/index',
      }),
    })
  },

  backHome() {
    wx.switchTab({ url: '/pages/home/index' })
  },

  handleImageError() {
    this.setData({ sourceImageError: true })
  },
})

function formatDateTime(timestamp: number) {
  const date = new Date(timestamp)
  const datePart = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, '0'))
    .join('-')
  const timePart = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${datePart} ${timePart}`
}
