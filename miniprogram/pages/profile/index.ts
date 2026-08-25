import { DOWNLOAD_PACKAGES, PROFILE_MENU_ITEMS } from '../../config/profile'
import { appStore } from '../../store/app-store'

Page({
  data: {
    menuItems: PROFILE_MENU_ITEMS,
    packages: DOWNLOAD_PACKAGES,
    workCount: 0,
    favoriteCount: 0,
    downloadCount: 0,
    downloadQuota: 0,
    avatarPath: '/assets/icons/brand-avatar.svg',
    showRecharge: false,
    selectedPackage: 0,
  },

  onShow() {
    this.getTabBar()?.setData({ selected: 2 })
    const state = appStore.getSnapshot()
    this.setData({
      workCount: state.works.length,
      favoriteCount: state.favoriteIds.length,
      downloadCount: state.downloadRecords.length,
      downloadQuota: state.downloadQuota,
      avatarPath: state.currentDraft?.sourceImagePath || '/assets/icons/brand-avatar.svg',
    })
  },

  openMenu(event: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: String(event.currentTarget.dataset.url) })
  },

  openProjects() {
    wx.switchTab({ url: '/pages/projects/index' })
  },

  openFavorites() {
    wx.navigateTo({ url: '/pages/favorites/index' })
  },

  openDownloads() {
    wx.navigateTo({ url: '/pages/downloads/index' })
  },

  showRechargeSheet() {
    wx.hideTabBar({ animation: false })
    this.getTabBar()?.setData({ hidden: true })
    this.setData({ showRecharge: true })
  },

  hideRechargeSheet() {
    this.setData({ showRecharge: false })
    this.getTabBar()?.setData({ hidden: false })
    wx.showTabBar({ animation: false })
  },

  onHide() {
    if (this.data.showRecharge) {
      this.getTabBar()?.setData({ hidden: false })
      wx.showTabBar({ animation: false })
    }
  },

  stopPropagation() {},

  selectPackage(event: WechatMiniprogram.TouchEvent) {
    this.setData({ selectedPackage: Number(event.currentTarget.dataset.index) })
  },

  purchase() {
    wx.showModal({
      title: '支付能力尚未接入',
      content: '下载套餐界面已经完成，待商户号、定价和付费服务协议确认后再接入微信支付。',
      showCancel: false,
    })
  },

  showLoginNotice() {
    wx.showToast({ title: '账号登录能力待接入', icon: 'none' })
  },
})
