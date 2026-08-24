const packages = [
  { id: 'starter', count: 5, price: '3.90', label: '轻量体验' },
  { id: 'popular', count: 20, price: '9.90', label: '最受欢迎' },
  { id: 'creator', count: 60, price: '19.90', label: '长期创作' },
]

Page({
  data: {
    packages,
    selected: 1,
  },

  selectPackage(event: WechatMiniprogram.TouchEvent) {
    this.setData({ selected: Number(event.currentTarget.dataset.index) })
  },

  purchase() {
    wx.showModal({
      title: '支付能力尚未接入',
      content: '套餐和界面已经预留，待商户号、定价与服务协议确认后再接微信支付。',
      showCancel: false,
    })
  },
})
