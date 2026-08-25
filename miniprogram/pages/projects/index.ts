import type { WorkItem } from '../../models/pattern'
import { appStore } from '../../store/app-store'

type ProjectTab = 'all' | 'recent' | 'draft' | 'completed'
type WorkView = WorkItem & {
  updatedText: string
  dimensions: string
  statusLabel: string
  isDraft: boolean
  isFavorite: boolean
}

const tabs = [
  { id: 'all', label: '全部' },
  { id: 'recent', label: '最近' },
  { id: 'draft', label: '草稿' },
  { id: 'completed', label: '已完成' },
] as const

Page({
  data: {
    tabs,
    activeTab: 'all' as ProjectTab,
    query: '',
    allWorks: [] as WorkView[],
    works: [] as WorkView[],
    recentCount: 0,
    draftCount: 0,
  },

  onShow() {
    this.getTabBar()?.setData({ selected: 1 })
    this.refreshWorks()
  },

  refreshWorks() {
    const state = appStore.getSnapshot()
    const currentDraft = state.currentDraft
    const allWorks = state.works.map((work) => {
      const isDraft = work.status === 'draft'
      const width = work.width ?? (currentDraft?.id === work.id ? currentDraft.settings.width : 0)
      const height = work.height ?? (currentDraft?.id === work.id ? currentDraft.settings.height : 0)
      return {
        ...work,
        updatedText: formatDateTime(work.updatedAt),
        dimensions: width && height ? `${width}×${height}` : '尺寸待同步',
        statusLabel: isDraft ? '草稿' : '已完成',
        isDraft,
        isFavorite: state.favoriteIds.includes(work.id),
      }
    })

    this.setData({
      allWorks,
      recentCount: allWorks.filter((work) => isRecent(work.updatedAt)).length,
      draftCount: allWorks.filter((work) => work.isDraft).length,
    }, () => this.applyFilters())
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
        const tab = ['all', 'recent', 'draft', 'completed'][tapIndex] as ProjectTab
        this.setData({ activeTab: tab }, () => this.applyFilters())
      },
    })
  },

  createNew() {
    wx.switchTab({ url: '/pages/home/index' })
  },

  openWork(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    const state = appStore.getSnapshot()
    if (state.currentDraft?.id === id) {
      const work = state.works.find((item) => item.id === id)
      wx.navigateTo({ url: work?.status === 'draft' ? '/pages/editor/index' : '/pages/result/index' })
      return
    }
    wx.showToast({ title: '历史作品详情服务待接入', icon: 'none' })
  },

  openWorkMenu(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    const work = this.data.allWorks.find((item) => item.id === id)
    if (!work) return
    const favoriteAction = work.isFavorite ? '取消收藏' : '收藏作品'
    wx.showActionSheet({
      itemList: ['查看详情', favoriteAction, '下载', '删除'],
      success: ({ tapIndex }) => {
        if (tapIndex === 0) this.openWork(event)
        if (tapIndex === 1) {
          appStore.toggleFavorite(id)
          this.refreshWorks()
        }
        if (tapIndex === 2) wx.navigateTo({ url: '/pages/downloads/index' })
        if (tapIndex === 3) this.confirmDelete(id, work.title)
      },
    })
  },

  confirmDelete(id: string, title: string) {
    wx.showModal({
      title: '删除作品',
      content: `确定删除“${title}”吗？本地记录删除后无法恢复。`,
      confirmColor: '#e5484d',
      success: ({ confirm }) => {
        if (!confirm) return
        appStore.deleteWork(id)
        this.refreshWorks()
      },
    })
  },
})

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
