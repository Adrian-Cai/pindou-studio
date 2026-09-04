import type { PrivacyPreferences } from '../../models/pattern'
import { appStore } from '../../store/app-store'

type PreferenceKey = keyof PrivacyPreferences

Page({
  data: {
    preferences: appStore.getSnapshot().privacyPreferences,
  },

  onShow() {
    this.setData({ preferences: appStore.getSnapshot().privacyPreferences })
  },

  changePreference(event: WechatMiniprogram.SwitchChange) {
    const key = String(event.currentTarget.dataset.key) as PreferenceKey
    const value = event.detail.value
    if (key === 'cloudSync' && value) {
      wx.showToast({ title: '云同步服务待接入', icon: 'none' })
      this.setData({ preferences: appStore.getSnapshot().privacyPreferences })
      return
    }
    appStore.setPrivacyPreferences({ [key]: value })
    this.setData({ preferences: appStore.getSnapshot().privacyPreferences })
  },

  openDocument(event: WechatMiniprogram.TouchEvent) {
    const title = String(event.currentTarget.dataset.title)
    const content = title === '第三方信息共享清单'
      ? '为完成内容安全审核，上传图片和作品名称会发送至微信内容安全服务。原始审核图片仅在服务端临时保存，审核完成或过期后清理。'
      : `${title}内容待发布`
    wx.showModal({ title, content, showCancel: false })
  },

  cancelAccount() {
    wx.showModal({
      title: '暂时无法注销',
      content: '当前版本尚未接入账号登录，因此没有可注销的线上账号。本地作品可在微信设置中清理小程序数据。',
      showCancel: false,
    })
  },
})
