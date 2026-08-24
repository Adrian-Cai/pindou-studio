import { SAMPLE_PALETTE } from '../../config/product'
import type { PatternDraft } from '../../models/pattern'
import { appStore } from '../../store/app-store'

Page({
  data: {
    draft: null as PatternDraft | null,
    activeTab: 'preview',
    isFavorite: false,
    tabs: [
      { id: 'preview', label: '成品图' },
      { id: 'materials', label: '材料清单' },
      { id: 'chart', label: '施工图' },
      { id: 'palette', label: '色板参考' },
    ],
    materials: SAMPLE_PALETTE.map((item, index) => ({
      ...item,
      count: 24 + ((index * 17) % 83),
    })),
  },

  onShow() {
    const state = appStore.getSnapshot()
    const draft = state.currentDraft
    this.setData({
      draft,
      isFavorite: draft ? state.favoriteIds.includes(draft.id) : false,
    })
  },

  changeTab(event: WechatMiniprogram.TouchEvent) {
    this.setData({ activeTab: String(event.currentTarget.dataset.tab) })
  },

  toggleFavorite() {
    const draft = this.data.draft
    if (!draft) return
    appStore.toggleFavorite(draft.id)
    this.setData({ isFavorite: !this.data.isFavorite })
  },

  openDownloads() {
    wx.navigateTo({ url: '/pages/downloads/index' })
  },

  goCreate() {
    wx.switchTab({ url: '/pages/home/index' })
  },

  onShareAppMessage() {
    return {
      title: '看看我刚生成的拼豆图纸',
      path: '/pages/home/index',
    }
  },
})
