import type { WorkItem } from '../../models/pattern'
import { appStore } from '../../store/app-store'

Page({
  data: {
    works: [] as WorkItem[],
  },

  onShow() {
    const state = appStore.getSnapshot()
    this.setData({
      works: state.works.filter((work) => state.favoriteIds.includes(work.id)),
    })
  },

  openCurrent(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    if (appStore.getSnapshot().currentDraft?.id === id) {
      wx.navigateTo({ url: '/pages/result/index' })
      return
    }
    wx.showToast({ title: '历史作品详情接口待接入', icon: 'none' })
  },
})
