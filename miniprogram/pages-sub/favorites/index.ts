import type { WorkItem } from '../../models/pattern'
import {
  cloudSummaryToWorkItem,
  cloudDetailToDraft,
  fetchCloudWork,
  fetchCloudFavorites,
  hasCloudSession,
  setCloudFavorite,
} from '../../services/work-service'
import { appStore } from '../../store/app-store'

type FavoriteTab = 'all' | 'recent' | 'inspiration' | 'completed'
type FavoriteView = Omit<WorkItem, 'favoritedAt'> & {
  favoritedAt: number
  dateText: string
  dimensions: string
}

const tabs = [
  { id: 'all', label: '全部' },
  { id: 'recent', label: '最近收藏' },
  { id: 'inspiration', label: '灵感图' },
  { id: 'completed', label: '已完成作品' },
] as const
const COVER_FALLBACK_PATH = '/assets/icons/image-upload.svg'

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
    void this.refreshFavorites()
  },

  async refreshFavorites() {
    if (hasCloudSession()) {
      try {
        let response = await fetchCloudFavorites()
        const cloudFavorites = [...response.items]
        while (cloudFavorites.length < response.total && response.items.length > 0) {
          response = await fetchCloudFavorites({
            page: response.page + 1,
            pageSize: response.pageSize,
          })
          cloudFavorites.push(...response.items)
        }
        appStore.replaceCloudFavorites(cloudFavorites.map(cloudSummaryToWorkItem))
      } catch (error) {
        console.error('读取云端收藏失败', error)
        wx.showToast({ title: '云端收藏加载失败，已显示本地缓存', icon: 'none' })
      }
    }
    const state = appStore.getSnapshot()
    const draft = state.currentDraft
    const allWorks = state.works
      .filter((work) => state.favoriteIds.includes(work.id))
      .map((work) => {
        const width = work.width ?? (draft?.id === work.id ? draft.settings.width : 0)
        const height = work.height ?? (draft?.id === work.id ? draft.settings.height : 0)
        const favoritedAt = work.favoritedAt ?? work.updatedAt
        return {
          ...work,
          favoritedAt,
          dateText: formatDate(favoritedAt),
          dimensions: width && height ? `${width}×${height}` : '尺寸待同步',
        }
      })
      .sort((a, b) => b.favoritedAt - a.favoritedAt)
    this.setData({
      allWorks,
      recentCount: allWorks.filter((work) => isRecent(work.favoritedAt)).length,
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
    this.setData({ activeTab: String(event.currentTarget.dataset.tab) as FavoriteTab }, () => this.applyFilters())
  },

  applyFilters() {
    const query = this.data.query.trim().toLowerCase()
    const activeTab = this.data.activeTab
    const works = this.data.allWorks.filter((work) => {
      if (query && !work.title.toLowerCase().includes(query)) return false
      if (activeTab === 'recent') return isRecent(work.favoritedAt)
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
          ? (a, b) => b.favoritedAt - a.favoritedAt
          : (a, b) => a.title.localeCompare(b.title, 'zh-CN'))
        this.setData({ allWorks }, () => this.applyFilters())
      },
    })
  },

  async openWork(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    const state = appStore.getSnapshot()
    const work = state.works.find((item) => item.id === id)
    if (!work) return
    if (state.currentDraft?.id === id) {
      wx.navigateTo({ url: '/pages-sub/result/index' })
      return
    }
    if (!work.isCloud) {
      const draft = appStore.getLocalDraft(id)
      if (!draft) { wx.showToast({ title: '这份本地作品缺少可恢复的图案数据', icon: 'none' }); return }
      await appStore.setCurrentDraft(draft)
      wx.navigateTo({ url: '/pages-sub/result/index' })
      return
    }
    wx.showLoading({ title: '正在读取', mask: true })
    try {
      const detail = await fetchCloudWork(id)
      await appStore.setCurrentDraft(cloudDetailToDraft(detail))
      await appStore.saveWork(cloudSummaryToWorkItem(detail))
      wx.navigateTo({ url: '/pages-sub/result/index' })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '作品读取失败，请重试', icon: 'none' })
    } finally { wx.hideLoading() }
  },

  async removeFavorite(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    const work = appStore.getSnapshot().works.find((item) => item.id === id)
    if (!work) return
    wx.showLoading({ title: '正在取消', mask: true })
    try {
      if (work.isCloud) await setCloudFavorite(id, false)
      await appStore.setFavorite(id, false)
      await this.refreshFavorites()
      wx.hideLoading()
      wx.showToast({ title: '已取消收藏', icon: 'none' })
    } catch (error) {
      console.error('取消收藏失败', error)
      wx.hideLoading()
      wx.showToast({ title: '取消收藏失败，请重试', icon: 'none' })
    }
  },

  downloadWork() {
    wx.navigateTo({ url: '/pages-sub/downloads/index' })
  },

  stopPropagation() {},
})

function isRecent(timestamp: number) {
  return Date.now() - timestamp <= 7 * 24 * 60 * 60 * 1000
}

function formatDate(timestamp: number) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
