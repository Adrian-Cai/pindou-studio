import { appStore } from '../../store/app-store'

const menuItems = [
  { id: 'favorites', symbol: '♡', title: '我的收藏', url: '/pages/favorites/index' },
  { id: 'downloads', symbol: '↓', title: '下载记录', url: '/pages/downloads/index' },
  { id: 'help', symbol: '?', title: '使用帮助', url: '/pages/help/index' },
  { id: 'feedback', symbol: '✎', title: '一键反馈', url: '/pages/feedback/index' },
  { id: 'privacy', symbol: '◈', title: '隐私设置', url: '/pages/privacy/index' },
  { id: 'about', symbol: 'i', title: '关于我们', url: '/pages/about/index' },
]

Page({
  data: {
    menuItems,
    workCount: 0,
    favoriteCount: 0,
    downloadQuota: 0,
  },

  onShow() {
    const state = appStore.getSnapshot()
    this.setData({
      workCount: state.works.length,
      favoriteCount: state.favoriteIds.length,
      downloadQuota: state.downloadQuota,
    })
  },

  openMenu(event: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: String(event.currentTarget.dataset.url) })
  },

  openProjects() {
    wx.switchTab({ url: '/pages/projects/index' })
  },

  openRecharge() {
    wx.navigateTo({ url: '/pages/recharge/index' })
  },
})
