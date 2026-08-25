import type { WorkItem } from '../../models/pattern'
import { appStore } from '../../store/app-store'

type FavoriteTab = 'all' | 'recent' | 'inspiration' | 'completed'
type FavoriteView = WorkItem & { dateText: string; dimensions: string }

const tabs = [
  { id: 'all', label: '全部' },
  { id: 'recent', label: '最近收藏' },
  { id: 'inspiration', label: '灵感图' },
  { id: 'completed', label: '已完成作品' },
] as const

Page({
  data: {
    tabs,
    activeTab: 'all' as FavoriteTab,
    query: '',
    allWorks: [] as FavoriteView[],
    works: [] as FavoriteView[],
    recentCount: 0,
  },

  onShow() {
    this.refreshFavorites()
  },

  refreshFavorites() {
    const state = appStore.getSnapshot()
    const draft = state.currentDraft
    const allWorks = state.works
      .filter((work) => state.favoriteIds.includes(work.id))
      .map((work) => {
        const width = work.width ?? (draft?.id === work.id ? draft.settings.width : 0)
        const height = work.height ?? (draft?.id === work.id ? draft.settings.height : 0)
        return {
          ...work,
          dateText: formatDate(work.updatedAt),
          dimensions: width && height ? `${width}×${height}` : '尺寸待同步',
        }
      })
    this.setData({
      allWorks,
      recentCount: allWorks.filter((work) => isRecent(work.updatedAt)).length,
    }, () => this.applyFilters())
  },

  changeSearch(event: WechatMiniprogram.Input) {
    this.setData({ query: event.detail.value }, () => this.applyFilters())
  },

  changeTab(event: WechatMiniprogram.TouchEvent) {
    this.setData({ activeTab: String(event.currentTarget.dataset.tab) as FavoriteTab }, () => this.applyFilters())
  },

  applyFilters() {
    const query = this.data.query.trim().toLowerCase()
    const activeTab = this.data.activeTab
    const works = this.data.allWorks.filter((work) => {
      if (query && !work.title.toLowerCase().includes(query)) return false
      if (activeTab === 'recent') return isRecent(work.updatedAt)
      if (activeTab === 'inspiration') return work.status === 'draft'
      if (activeTab === 'completed') return work.status !== 'draft'
      return true
    })
    this.setData({ works })
  },

  showSort() {
    wx.showActionSheet({
      itemList: ['按收藏时间', '按作品名称'],
      success: ({ tapIndex }) => {
        const allWorks = [...this.data.allWorks]
        allWorks.sort(tapIndex === 0
          ? (a, b) => b.updatedAt - a.updatedAt
          : (a, b) => a.title.localeCompare(b.title, 'zh-CN'))
        this.setData({ allWorks }, () => this.applyFilters())
      },
    })
  },

  openWork(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    if (appStore.getSnapshot().currentDraft?.id === id) {
      wx.navigateTo({ url: '/pages/result/index' })
      return
    }
    wx.showToast({ title: '历史作品详情服务待接入', icon: 'none' })
  },

  removeFavorite(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    appStore.toggleFavorite(id)
    this.refreshFavorites()
    wx.showToast({ title: '已取消收藏', icon: 'none' })
  },

  openMenu(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    wx.showActionSheet({
      itemList: ['查看作品', '取消收藏', '下载'],
      success: ({ tapIndex }) => {
        if (tapIndex === 0) this.openWork(event)
        if (tapIndex === 1) {
          appStore.toggleFavorite(id)
          this.refreshFavorites()
        }
        if (tapIndex === 2) wx.navigateTo({ url: '/pages/downloads/index' })
      },
    })
  },
})

function isRecent(timestamp: number) {
  return Date.now() - timestamp <= 7 * 24 * 60 * 60 * 1000
}

function formatDate(timestamp: number) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
