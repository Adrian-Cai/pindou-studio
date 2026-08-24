import { appStore } from '../../store/app-store'

Page({
  data: {
    hasDraft: false,
    quota: 0,
  },

  onShow() {
    const state = appStore.getSnapshot()
    this.setData({
      hasDraft: Boolean(state.currentDraft),
      quota: state.downloadQuota,
    })
  },

  exportCurrent() {
    wx.showToast({ title: '导出服务接口待接入', icon: 'none' })
  },
})
