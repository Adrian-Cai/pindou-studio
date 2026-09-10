import type { WorkItem } from '../../models/pattern'
import {
  cloudDetailToDraft,
  cloudSummaryToWorkItem,
  deleteCloudWork,
  fetchCloudWork,
  fetchCloudWorks,
  hasCloudSession,
  renameCloudWork,
} from '../../services/work-service'
import { appStore } from '../../store/app-store'
import { checkTextContent } from '../../services/content-security-service'

type ProjectTab = 'all' | 'recent' | 'draft' | 'completed'
type WorkView = WorkItem & {
  updatedText: string
  dimensions: string
  statusLabel: string
  isDraft: boolean
  syncLabel: string
}
const tabs = [
  { id: 'all', label: '全部' },
  { id: 'recent', label: '最近' },
  { id: 'draft', label: '草稿' },
  { id: 'completed', label: '已完成' },
] as const
const COVER_FALLBACK_PATH = '/assets/icons/image-upload.svg'

Page({
  data: {
    tabs,
    activeTab: 'all' as ProjectTab,
    query: '',
    allWorks: [] as WorkView[],
    works: [] as WorkView[],
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

  onShow() {
    this.getTabBar()?.setData({ selected: 1, hidden: Boolean(this.data.renameWorkId) })
    void this.refreshWorks()
  },

  async refreshWorks() {
    if (hasCloudSession()) {
      this.setData({ loading: true })
      try {
        const response = await fetchCloudWorks()
        appStore.replaceCloudWorks(response.items.map(cloudSummaryToWorkItem))
      } catch (error) {
        console.error('读取云端作品失败', error)
        wx.showToast({ title: '云端作品加载失败，已显示本地缓存', icon: 'none' })
      } finally {
        this.setData({ loading: false })
      }
    }
    this.refreshVisibleWorks()
  },

  refreshVisibleWorks() {
    const state = appStore.getSnapshot()
    const currentDraft = state.currentDraft
    const allWorks = state.works.map((work) => {
      const isDraft = work.status === 'draft'
      const width = work.width ?? (currentDraft?.id === work.id ? currentDraft.settings.width : 0)
      const height = work.height ?? (currentDraft?.id === work.id ? currentDraft.settings.height : 0)
      return {
        ...work,
        coverPath: work.coverPath || COVER_FALLBACK_PATH,
        updatedText: formatDateTime(work.updatedAt),
        dimensions: width && height ? `${width}×${height}` : '尺寸待同步',
        statusLabel: isDraft ? '草稿' : '已完成',
        isDraft,
        syncLabel: syncLabel(work),
      }
    })

    this.setData({
      allWorks,
      recentCount: allWorks.filter((work) => isRecent(work.updatedAt)).length,
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
      if (activeTab === 'recent') return isRecent(work.updatedAt)
      if (activeTab === 'draft') return work.isDraft
      if (activeTab === 'completed') return !work.isDraft
      return true
    })
    this.setData({ works })
  },

  showFilter() {
    wx.showActionSheet({
      itemList: ['全部作品', '最近更新', '仅看草稿', '仅看已完成'],
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

  editWork(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    void this.openWorkById(id, true)
  },

  async openWorkById(id: string, edit: boolean) {
    const state = appStore.getSnapshot()
    const work = state.works.find((item) => item.id === id)
    if (!work) return
    if (work.isCloud) {
      wx.showLoading({ title: '正在读取', mask: true })
      try {
        const detail = await fetchCloudWork(id)
        await appStore.setCurrentDraft(cloudDetailToDraft(detail))
        await appStore.saveWork(cloudSummaryToWorkItem(detail))
        wx.navigateTo({ url: edit ? '/pages-sub/editor/index' : '/pages-sub/result/index' })
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
      wx.navigateTo({ url: edit ? '/pages-sub/editor/index' : '/pages-sub/result/index' })
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
      if (work.isCloud) {
        const summary = await renameCloudWork(id, title)
        await appStore.saveWork(cloudSummaryToWorkItem(summary))
      } else {
        await appStore.saveWork({ ...work, title, updatedAt: Date.now() })
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
      wx.navigateTo({ url: '/pages-sub/downloads/index' })
    })
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

function validateWorkTitle(value: string, originalTitle: string) {
  const title = value.trim()
  if (!title) return { title, error: '作品名称不能为空', canSave: false }
  if (Array.from(title).length > 120) return { title, error: '作品名称不能超过 120 个字符', canSave: false }
  if (/[\u0000-\u001f\u007f]/u.test(title)) return { title, error: '作品名称包含不可用字符', canSave: false }
  if (title === originalTitle) return { title, error: '', canSave: false }
  return { title, error: '', canSave: true }
}

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
