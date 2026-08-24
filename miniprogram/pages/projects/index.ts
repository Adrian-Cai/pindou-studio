import type { WorkItem } from '../../models/pattern'
import { appStore } from '../../store/app-store'

type WorkView = WorkItem & { updatedText: string }

Page({
  data: {
    works: [] as WorkView[],
  },

  onShow() {
    const works = appStore.getSnapshot().works.map((work) => ({
      ...work,
      updatedText: formatDate(work.updatedAt),
    }))
    this.setData({ works })
  },

  createNew() {
    wx.switchTab({ url: '/pages/home/index' })
  },

  openWork(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    if (appStore.getSnapshot().currentDraft?.id === id) {
      wx.navigateTo({ url: '/pages/result/index' })
      return
    }
    wx.showToast({ title: '历史作品详情接口待接入', icon: 'none' })
  },
})

function formatDate(timestamp: number) {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return date.getFullYear() + '.' + month + '.' + day
}
