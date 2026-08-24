import type { PatternDraft } from '../../models/pattern'
import { appStore } from '../../store/app-store'

Page({
  data: {
    draft: null as PatternDraft | null,
    zoom: 1,
    zoomPercent: 100,
    activeTool: 'move',
    tools: [
      { id: 'move', label: '移动', symbol: '✥' },
      { id: 'paint', label: '画笔', symbol: '●' },
      { id: 'erase', label: '橡皮', symbol: '◇' },
      { id: 'replace', label: '换色', symbol: '↔' },
    ],
  },

  onLoad() {
    const draft = appStore.getSnapshot().currentDraft
    if (!draft) {
      wx.showToast({ title: '请先选择图片', icon: 'none' })
      setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 500)
      return
    }
    this.setData({ draft })
  },

  selectTool(event: WechatMiniprogram.TouchEvent) {
    this.setData({ activeTool: String(event.currentTarget.dataset.tool) })
  },

  zoomIn() {
    const zoom = Math.min(1.6, this.data.zoom + 0.1)
    this.setData({ zoom, zoomPercent: Math.round(zoom * 100) })
  },

  zoomOut() {
    const zoom = Math.max(0.7, this.data.zoom - 0.1)
    this.setData({ zoom, zoomPercent: Math.round(zoom * 100) })
  },

  saveAndView() {
    const draft = this.data.draft
    if (!draft) return
    appStore.saveWork({
      id: draft.id,
      title: '未命名作品',
      coverPath: draft.sourceImagePath,
      updatedAt: Date.now(),
      beadCount: draft.settings.width * draft.settings.height,
      colorCount: draft.settings.colorLimit,
    })
    wx.navigateTo({ url: '/pages/result/index' })
  },
})
