/**
 * 「我的作品」列表页：展示/筛选/搜索本地+云端作品，支持打开、改名、删除、下载。
 *
 * 职责：聚合 appStore 中的作品与云端作品（登录时拉取并写入本地），按 tab/搜索过滤渲染；
 *       打开云端作品时取详情还原草稿并跳转编辑器/结果页；不负责图纸生成与绘制。
 * 调用方：tabBar 第 2 项（路由 /pages/projects/index）。
 * 关键点：AI 生成任务是 appStore.works 里的真实作品记录；未完成的文生图失败任务只在列表展示占位卡，
 *       不伪装成已保存作品。封面加载失败回退到占位图（COVER_FALLBACK_PATH）。
 */
import { isAiTaskWork, isWorkDraft, type WorkItem } from '../../models/pattern'
import {
  cloudDetailToDraft,
  cloudSummaryToWorkItem,
  deleteCloudWork,
  fetchCloudWork,
  fetchCloudWorks,
  hasCloudSession,
  renameCloudWork,
} from '../../services/work-service'
import { appStore, LocalStorageError } from '../../store/app-store'
import { deleteFailedTextGeneration, fetchRecoverableTextGenerations, type TextGeneration } from '../../services/text-generation-service'
import {
  deleteTextImageWork as deleteCloudTextImageWork,
  fetchTextImageWorks,
  type TextImageWork,
} from '../../services/text-image-work-service'
import { checkTextContent } from '../../services/content-security-service'
import {
  aiTaskManager,
  canRetryTask,
  retryActionLabel,
} from '../../services/ai-generation-manager'

type ProjectTab = 'all' | 'recent' | 'draft' | 'completed' | 'text'
type WorkView = WorkItem & {
  updatedText: string
  dimensions: string
  statusLabel: string
  isDraft: boolean
  syncLabel: string
  isAiTask: boolean
  isAiGenerating: boolean
  isAiFailed: boolean
  /** 0-100，随 aiTaskManager 通知刷新 */
  aiProgress: number
  /** AI 卡片失败原因文案（ai_failed 才有） */
  failureMessage: string
  canRetry: boolean
  retryLabel: string
}
type FailedTextTaskView = Pick<TextGeneration, 'id' | 'prompt' | 'updatedAt'> & {
  coverPath: string
  updatedText: string
}
type TextImageWorkView = TextImageWork & { coverPath: string; updatedText: string }
const tabs = [
  { id: 'all', label: '全部' },
  { id: 'recent', label: '最近' },
  { id: 'draft', label: '草稿' },
  { id: 'completed', label: '已完成' },
  { id: 'text', label: '文生图' },
] as const
// 封面加载失败时的占位图
const COVER_FALLBACK_PATH = '/assets/icons/image-upload.svg'

Page({
  data: {
    tabs,
    activeTab: 'all' as ProjectTab,
    query: '',
    allWorks: [] as WorkView[],
    works: [] as WorkView[],
    textJobs: [] as TextGeneration[],
    failedTextJobs: [] as FailedTextTaskView[],
    visibleFailedTextJobs: [] as FailedTextTaskView[],
    textImageWorks: [] as TextImageWorkView[],
    visibleTextImageWorks: [] as TextImageWorkView[],
    allCount: 0,
    recentCount: 0,
    draftCount: 0,
    loading: false,
    showPageNav: true,
    renameWorkId: '',
    renameOriginalTitle: '',
    renameDraft: '',
    renameLength: 0,
    renameError: '',
    renameCanSave: false,
    renameSaving: false,
  },

  _unsubscribeAiTask: null as (() => void) | null,

  onShow() {
    this.getTabBar()?.setData({ selected: 1, hidden: Boolean(this.data.renameWorkId) })
    if (!this._unsubscribeAiTask) {
      this._unsubscribeAiTask = aiTaskManager.subscribeAll(() => this.refreshVisibleWorks())
    }
    void this.refreshWorks()
  },

  onHide() {
    this._unsubscribeAiTask?.()
    this._unsubscribeAiTask = null
  },

  onUnload() {
    this._unsubscribeAiTask?.()
    this._unsubscribeAiTask = null
  },

  async refreshWorks() {
    // 未登录时没有云端列表可拉，直接渲染本地缓存
    if (!hasCloudSession()) {
      this.setData({ textJobs: [], failedTextJobs: [], visibleFailedTextJobs: [], textImageWorks: [], visibleTextImageWorks: [] })
      this.refreshVisibleWorks()
      return
    }
    this.setData({ loading: true })
    try {
      const [worksResult, textJobsResult, textImageWorksResult] = await Promise.allSettled([
        fetchCloudWorks(),
        fetchRecoverableTextGenerations(),
        fetchTextImageWorks(),
      ])
      if (textJobsResult.status === 'fulfilled') {
        const failedTextJobs = textJobsResult.value
          .filter((task) => task.status === 'failed')
          .map((task) => ({
            ...task,
            coverPath: COVER_FALLBACK_PATH,
            updatedText: formatDateTime(Date.parse(task.updatedAt)),
          }))
        this.setData({
          textJobs: textJobsResult.value.filter((task) => task.status !== 'failed'),
          failedTextJobs,
        })
      } else console.warn('读取文生图恢复任务失败', textJobsResult.reason)
      if (textImageWorksResult.status === 'fulfilled') {
        const textImageWorks = textImageWorksResult.value.items.map((work) => ({
          ...work,
          coverPath: work.coverUrl,
          updatedText: formatDateTime(Date.parse(work.updatedAt)),
        }))
        this.setData({ textImageWorks })
      } else console.warn('读取文生图作品失败', textImageWorksResult.reason)
      if (worksResult.status === 'rejected') {
        // 这里是**网络/接口**失败，本地缓存还在，按「加载失败」提示
        console.error('读取云端作品失败', worksResult.reason)
        wx.showToast({ title: '云端作品加载失败，已显示本地缓存', icon: 'none' })
        return
      }
      try {
        await appStore.replaceCloudWorks(worksResult.value.items.map(cloudSummaryToWorkItem))
      } catch (error) {
        // 云端已经读回来了，写不进去只可能是本机落盘（典型是 storage 写满）。
        // 列表内存态已经更新，这里如实告诉用户「没存住」，而不是谎报云端加载失败。
        console.error('云端作品写入本机失败', error)
        wx.showToast({
          title: error instanceof LocalStorageError ? error.message : '本机保存失败，请清理空间后重试',
          icon: 'none',
        })
      }
    } finally {
      // 「复位 loading + 重渲染」是这段刷新的唯一出口：提前 return / 网络失败 / 落盘失败
      // 都从这里走。写成单点出口后，将来再加分支也不可能漏掉 loading 导致页面一直转圈。
      this.setData({ loading: false })
      this.refreshVisibleWorks()
    }
  },

  refreshVisibleWorks() {
    const state = appStore.getSnapshot()
    const currentDraft = state.currentDraft
    const allWorks: WorkView[] = state.works.map((work) => {
      const isAiTask = isAiTaskWork(work)
      const isAiGenerating = work.status === 'ai_pending'
      const isAiFailed = work.status === 'ai_failed'
      // 缺尺寸的作品尝试用当前草稿补（尺寸待云端同步时显示「尺寸待同步」）
      const width = work.width ?? (currentDraft?.id === work.id ? currentDraft.settings.width : 0)
      const height = work.height ?? (currentDraft?.id === work.id ? currentDraft.settings.height : 0)
      const taskView = aiTaskManager.getTaskView(work.id)
      return {
        ...work,
        coverPath: work.coverPath || COVER_FALLBACK_PATH,
        updatedText: isAiTask
          ? `${formatDateTime(work.createdAt ?? work.updatedAt)} 提交`
          : formatDateTime(work.updatedAt),
        dimensions: width && height ? `${width}×${height}` : '尺寸待同步',
        statusLabel: statusLabel(work),
        isDraft: isWorkDraft(work),
        // AI 占位作品只存本机，展示同步标签只会让人困惑
        syncLabel: isAiTask ? '' : syncLabel(work),
        isAiTask,
        isAiGenerating,
        isAiFailed,
        aiProgress: taskView?.progress ?? PHASE_FALLBACK_PROGRESS,
        failureMessage: isAiFailed ? work.failureMessage ?? '生成失败，请重试' : '',
        canRetry: isAiFailed && canRetryTask(work.failureCode),
        retryLabel: retryActionLabel(work.failureCode),
      }
    }).sort((left, right) => right.updatedAt - left.updatedAt)

    this.setData({
      allWorks,
      allCount: allWorks.length + this.data.textImageWorks.length,
      recentCount: allWorks.filter((work) => isRecent(work.updatedAt)).length
        + this.data.textImageWorks.filter((work) => isRecent(Date.parse(work.updatedAt))).length,
      draftCount: allWorks.filter((work) => work.isDraft).length,
    }, () => this.applyFilters())
  },

  handleCoverError(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? '')
    if (!id) return
    const work = this.data.allWorks.find((item) => item.id === id)
    if (!work || work.coverPath === COVER_FALLBACK_PATH) return
    const allWorks = this.data.allWorks.map((work) => work.id === id
      ? { ...work, coverPath: COVER_FALLBACK_PATH }
      : work)
    this.setData({ allWorks }, () => this.applyFilters())
  },

  handleTextImageCoverError(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? '')
    if (!id) return
    const textImageWorks = this.data.textImageWorks.map((work) => work.id === id
      ? { ...work, coverPath: COVER_FALLBACK_PATH }
      : work)
    this.setData({ textImageWorks }, () => this.applyFilters())
  },

  changeSearch(event: WechatMiniprogram.Input) {
    this.setData({ query: event.detail.value }, () => this.applyFilters())
  },

  changeTab(event: WechatMiniprogram.TouchEvent) {
    this.setData({ activeTab: String(event.currentTarget.dataset.tab) as ProjectTab }, () => this.applyFilters())
  },

  applyFilters() {
    const query = this.data.query.trim().toLowerCase()
    const activeTab = this.data.activeTab
    const works = this.data.allWorks.filter((work) => {
      if (query && !work.title.toLowerCase().includes(query)) return false
      if (activeTab === 'text') return false
      if (activeTab === 'recent') return isRecent(work.updatedAt)
      if (activeTab === 'draft') return work.isDraft
      if (activeTab === 'completed') return !work.isDraft
      return true
    })
    const failedTextJobs = this.data.failedTextJobs.filter((task) => {
      if (activeTab === 'draft' || activeTab === 'completed' || activeTab === 'text') return false
      if (query && !task.prompt.toLowerCase().includes(query) && !'文生图创作'.includes(query)) return false
      return activeTab !== 'recent' || isRecent(Date.parse(task.updatedAt))
    })
    const visibleTextImageWorks = this.data.textImageWorks.filter((work) => {
      if (query && !work.prompt.toLowerCase().includes(query) && !work.title.toLowerCase().includes(query)) return false
      if (activeTab === 'draft') return false
      if (activeTab === 'recent') return isRecent(Date.parse(work.updatedAt))
      return activeTab === 'all' || activeTab === 'completed' || activeTab === 'text'
    })
    this.setData({ works, visibleFailedTextJobs: failedTextJobs, visibleTextImageWorks })
  },

  showFilter() {
    wx.showActionSheet({
      itemList: ['全部作品', '最近更新', '仅看草稿', '仅看已完成', '仅看文生图'],
      success: ({ tapIndex }) => {
        const tab = tabs[tapIndex]?.id
        if (!tab) return
        this.setData({ activeTab: tab }, () => this.applyFilters())
      },
    })
  },

  createNew() {
    wx.switchTab({ url: '/pages/home/index' })
  },

  openWork(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    void this.openWorkById(id, false)
  },

  openTextTask(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? '')
    if (!id) return
    wx.navigateTo({ url: `/packages/ai-generation/text/index?taskId=${encodeURIComponent(id)}&from=projects` })
  },

  openTextImageWork(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? '')
    if (!id) return
    wx.navigateTo({ url: `/packages/ai-generation/text/index?workId=${encodeURIComponent(id)}&from=projects` })
  },

  deleteFailedTextTask(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? '')
    const task = this.data.failedTextJobs.find((item) => item.id === id)
    if (!task) return
    wx.showModal({
      title: '删除失败记录？',
      content: '删除后无法恢复这条文生图任务，AI 额度流水不会改变。',
      cancelText: '保留',
      confirmText: '删除',
      confirmColor: '#e5484d',
      success: ({ confirm }) => {
        if (!confirm) return
        void this.removeFailedTextTask(id)
      },
    })
  },

  async removeFailedTextTask(id: string) {
    try {
      await deleteFailedTextGeneration(id)
      await this.refreshWorks()
      wx.showToast({ title: '已删除', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '删除失败，请重试', icon: 'none' })
    }
  },

  deleteTextImageWork(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? '')
    const work = this.data.textImageWorks.find((item) => item.id === id)
    if (!work) return
    wx.showModal({
      title: '删除文生图作品？',
      content: '删除后无法恢复这张原图。',
      cancelText: '取消',
      confirmText: '删除',
      confirmColor: '#e5484d',
      success: ({ confirm }) => {
        if (!confirm) return
        void this.removeTextImageWork(id)
      },
    })
  },

  async removeTextImageWork(id: string) {
    try {
      await deleteCloudTextImageWork(id)
      this.setData({ textImageWorks: this.data.textImageWorks.filter((work) => work.id !== id) }, () => {
        this.refreshVisibleWorks()
      })
      wx.showToast({ title: '已删除', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '删除失败，请重试', icon: 'none' })
    }
  },

  async showSourcePrompt(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? '')
    const work = this.data.allWorks.find((item) => item.id === id)
    if (!work || work.creationSource !== 'text') return
    let prompt = work.sourcePrompt
    if (!prompt && work.isCloud) {
      try {
        prompt = (await fetchCloudWork(id)).sourcePrompt ?? ''
      } catch (error) {
        wx.showToast({ title: error instanceof Error ? error.message : '读取创作描述失败', icon: 'none' })
        return
      }
    }
    if (!prompt) {
      wx.showToast({ title: '没有找到这段创作描述', icon: 'none' })
      return
    }
    wx.showModal({ title: '创作描述', content: prompt, showCancel: false, confirmText: '知道了' })
  },

  editWork(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    void this.openWorkById(id, true)
  },

  async openWorkById(id: string, edit: boolean) {
    const state = appStore.getSnapshot()
    const work = state.works.find((item) => item.id === id)
    if (!work) return
    // AI 占位作品：跳到对应任务的详情页看进度/重试
    if (isAiTaskWork(work)) {
      wx.navigateTo({ url: `/packages/ai-generation/index?taskId=${encodeURIComponent(id)}&from=projects` })
      return
    }
    if (work.isCloud) {
      // 云端作品：先取完整详情还原草稿，再跳转（编辑→编辑器页，查看→结果页）
      wx.showLoading({ title: '正在读取', mask: true })
      try {
        const detail = await fetchCloudWork(id)
        // 顺序要紧：先落 WorkItem，再设当前草稿。
        // setCurrentDraft 靠 id 能否在云端列表里找到来判定归属，反过来的话这份
        // 草稿会被当成游客草稿落进 guest 区，本站看不到、下次同步也带上不去。
        await appStore.saveWork(cloudSummaryToWorkItem(detail))
        await appStore.setCurrentDraft(cloudDetailToDraft(detail))
        wx.navigateTo({ url: edit ? '/packages/editor/index' : '/packages/result/index' })
      } catch (error) {
        console.error('读取作品详情失败', error)
        wx.showToast({
          title: error instanceof Error ? error.message : '作品读取失败，请重试',
          icon: 'none',
        })
      } finally {
        wx.hideLoading()
      }
      return
    }
    if (state.currentDraft?.id === id) {
      wx.navigateTo({ url: edit ? '/packages/editor/index' : '/packages/result/index' })
      return
    }
    const localDraft = appStore.getLocalDraft(id)
    if (localDraft) {
      await appStore.setCurrentDraft(localDraft)
      wx.navigateTo({ url: edit ? '/packages/editor/index' : '/packages/result/index' })
      return
    }
    wx.showToast({ title: '这份本地作品缺少可恢复的网格数据', icon: 'none' })
  },

  stopPropagation() {},

  startRename(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    const work = this.data.allWorks.find((item) => item.id === id)
    if (!work) return
    this.getTabBar()?.setData({ hidden: true })
    this.setData({
      showPageNav: false,
      renameWorkId: work.id,
      renameOriginalTitle: work.title,
      renameDraft: work.title,
      renameLength: Array.from(work.title).length,
      renameError: '',
      renameCanSave: false,
    })
  },

  changeRenameDraft(event: WechatMiniprogram.Input) {
    const renameDraft = event.detail.value
    const validation = validateWorkTitle(renameDraft, this.data.renameOriginalTitle)
    this.setData({
      renameDraft,
      renameLength: Array.from(renameDraft).length,
      renameError: validation.error,
      renameCanSave: validation.canSave,
    })
  },

  closeRenameDialog() {
    if (this.data.renameSaving) return
    this.resetRenameDialog()
  },

  submitRename() {
    if (this.data.renameSaving) return
    const validation = validateWorkTitle(this.data.renameDraft, this.data.renameOriginalTitle)
    if (!validation.canSave) {
      this.setData({ renameError: validation.error })
      return
    }
    void this.persistRename(this.data.renameWorkId, validation.title)
  },

  async persistRename(id: string, title: string) {
    if (!id || this.data.renameSaving) return
    const work = appStore.getSnapshot().works.find((item) => item.id === id)
    if (!work) {
      this.setData({ renameError: '作品记录不存在，请刷新后重试' })
      return
    }
    this.setData({ renameSaving: true })
    try {
      await checkTextContent(title)
      // await 期间可能已完成一次云同步：本地作品被换成云端记录（id 都变了），
      // 这时再把 await 之前那份快照写回去，等于把已经被替换掉的旧记录重新塞回列表，
      // 用户看到的是「重命名成功，但列表里多了一份同名旧作品」。
      // 因此写之前必须重新取一次，取不到就说明它已被同步/删除，这次改名直接放弃。
      const current = appStore.getSnapshot().works.find((item) => item.id === id)
      if (!current) {
        this.refreshVisibleWorks()
        this.setData({
          renameError: '作品状态已变化，请刷新后重试',
          renameSaving: false,
        })
        return
      }
      // 云端作品走 renameCloudWork，其余直接改本地 store
      if (current.isCloud) {
        const summary = await renameCloudWork(id, title)
        await appStore.saveWork(cloudSummaryToWorkItem(summary))
      } else {
        await appStore.saveWork({ ...current, title, updatedAt: Date.now() })
      }
      this.refreshVisibleWorks()
      this.resetRenameDialog()
      wx.showToast({ title: '已重命名', icon: 'success' })
    } catch (error) {
      console.error('重命名作品失败', error)
      this.setData({
        renameError: error instanceof Error ? error.message : '更新失败，请重试',
        renameSaving: false,
      })
    }
  },

  resetRenameDialog() {
    this.getTabBar()?.setData({ hidden: false })
    this.setData({
      showPageNav: true,
      renameWorkId: '',
      renameOriginalTitle: '',
      renameDraft: '',
      renameLength: 0,
      renameError: '',
      renameCanSave: false,
      renameSaving: false,
    })
  },

  downloadWork(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    if (!this.data.allWorks.some((work) => work.id === id)) return
    this.getTabBar()?.setData({ hidden: false })
    this.setData({ showPageNav: true }, () => {
      void this.openWorkById(id, false)
    })
  },

  /** AI 卡片「取消任务 / 删除」：停止任务 + 删除占位作品。 */
  cancelAiTask(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? '')
    if (!id) return
    const work = this.data.allWorks.find((item) => item.id === id)
    if (!work) return
    const isGenerating = work.status === 'ai_pending'
    wx.showModal({
      title: isGenerating ? '取消任务？' : '删除这条记录？',
      content: isGenerating
        ? '确定要取消这个 AI 生成任务吗？'
        : `确定要删除“${work.title}”吗？`,
      cancelText: '保留',
      confirmText: isGenerating ? '取消任务' : '删除',
      confirmColor: '#e5484d',
      success: ({ confirm }) => {
        if (!confirm) return
        void aiTaskManager.cancelTask(id).then(() => this.refreshVisibleWorks())
      },
    })
  },

  /** AI 卡片「重试」：图片/内容类问题不在这里重试（文案会引导用户重新选图）。 */
  retryAiTask(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? '')
    if (!id) return
    const work = this.data.allWorks.find((item) => item.id === id)
    if (!work?.canRetry) return
    void aiTaskManager.retryTask(id).then(() => this.refreshVisibleWorks())
  },

  deleteWork(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    const work = this.data.allWorks.find((item) => item.id === id)
    if (!work) return
    this.getTabBar()?.setData({ hidden: false })
    this.setData({ showPageNav: true }, () => {
      this.confirmDelete(work.id, work.title, Boolean(work.isCloud))
    })
  },

  confirmDelete(id: string, title: string, isCloud: boolean) {
    wx.showModal({
      title: '删除作品？',
      content: `删除后无法恢复，确定删除“${title}”吗？`,
      cancelText: '取消',
      confirmText: '删除',
      confirmColor: '#e5484d',
      success: ({ confirm }) => {
        if (!confirm) return
        void this.persistDelete(id, isCloud)
      },
    })
  },

  async persistDelete(id: string, isCloud: boolean) {
    wx.showLoading({ title: '正在删除', mask: true })
    try {
      if (isCloud) await deleteCloudWork(id)
      await appStore.deleteWork(id)
      this.refreshVisibleWorks()
    } catch (error) {
      console.error('删除作品失败', error)
      wx.showToast({ title: error instanceof Error ? error.message : '删除失败，请重试', icon: 'none' })
      return
    } finally {
      wx.hideLoading()
    }
    wx.showToast({ title: '已删除', icon: 'success' })
  },
})

/** 作品缺失任务记录时的兜底进度（例如任务记录已被清理但作品还在）。 */
const PHASE_FALLBACK_PROGRESS = 0

function statusLabel(work: WorkItem): string {
  if (work.status === 'ai_pending') return '生成中'
  if (work.status === 'ai_failed') return '生成失败'
  return isWorkDraft(work) ? '草稿' : '已完成'
}

function validateWorkTitle(value: string, originalTitle: string) {
  const title = value.trim()
  if (!title) return { title, error: '作品名称不能为空', canSave: false }
  if (Array.from(title).length > 120) return { title, error: '作品名称不能超过 120 个字符', canSave: false }
  if (/[\u0000-\u001f\u007f]/u.test(title)) return { title, error: '作品名称包含不可用字符', canSave: false }
  if (title === originalTitle) return { title, error: '', canSave: false }
  return { title, error: '', canSave: true }
}

// 近 30 天内的作品算「最近」
function isRecent(timestamp: number) {
  return Date.now() - timestamp <= 30 * 24 * 60 * 60 * 1000
}

function formatDateTime(timestamp: number) {
  const date = new Date(timestamp)
  const datePart = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, '0'))
    .join('-')
  const timePart = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${datePart} ${timePart}`
}

function syncLabel(work: WorkItem): string {
  if (work.syncStatus === 'pending') return '待同步'
  if (work.syncStatus === 'failed') return '同步失败'
  if (work.syncStatus === 'guest') return '仅本机'
  return ''
}
