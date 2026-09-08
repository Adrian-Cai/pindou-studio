import { DOWNLOAD_PACKAGES } from '../../config/profile'
import { appStore } from '../../store/app-store'

Page({
  data: {
    packages: DOWNLOAD_PACKAGES,
    selected: 0,
    quota: 0,
  },

  onShow() {
    this.setData({ quota: appStore.getSnapshot().downloadQuota })
  },

  selectPackage(event: WechatMiniprogram.TouchEvent) {
    this.setData({ selected: Number(event.currentTarget.dataset.index) })
  },

  purchase() {
    wx.showModal({
      title: '支付能力尚未接入',
      content: '套餐页面已经完成待商户号、正式定价和付费服务协议确认后，再调用微信支付并跳转支付成功页',
      showCancel: false,
    })
  },
})
