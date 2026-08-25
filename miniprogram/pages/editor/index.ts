import type { PatternDraft } from '../../models/pattern'
import { appStore } from '../../store/app-store'

interface PatternCanvas {
  width: number
  height: number
  getContext(type: '2d'): PatternCanvasContext
}

interface PatternCanvasContext {
  fillStyle: string
  globalAlpha: number
  scale(x: number, y: number): void
  fillRect(x: number, y: number, width: number, height: number): void
  beginPath(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  fill(): void
}

interface CanvasQueryResult {
  node: PatternCanvas
  width: number
  height: number
}

Page({
  data: {
    draft: null as PatternDraft | null,
    zoom: 1,
    zoomPercent: 100,
    beadCount: 0,
    paletteColors: [] as string[],
    selectedColor: '',
    activeTool: 'fill',
    tools: [
      { id: 'undo', label: '撤销', icon: '/assets/icons/editor-undo.svg', disabled: false },
      { id: 'redo', label: '重做', icon: '/assets/icons/editor-redo.svg', disabled: true },
      { id: 'eyedropper', label: '吸管', icon: '/assets/icons/editor-eyedropper.svg', disabled: false },
      { id: 'fill', label: '填充', icon: '/assets/icons/editor-fill.svg', disabled: false },
      { id: 'eraser', label: '橡皮擦', icon: '/assets/icons/editor-eraser.svg', disabled: false },
    ],
  },

  onLoad() {
    const draft = appStore.getSnapshot().currentDraft
    if (!draft) {
      wx.showToast({ title: '请先选择图片', icon: 'none' })
      setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 500)
      return
    }

    const paletteColors = this.getPaletteColors(draft)
    this.setData({
      draft,
      paletteColors,
      selectedColor: paletteColors[0] ?? '',
      beadCount: draft.cells.filter((cell) => cell.color !== 'transparent').length,
    })
  },

  onReady() {
    this.drawPattern()
  },

  getPaletteColors(draft: PatternDraft): string[] {
    const counts = new Map<string, number>()
    draft.cells.forEach((cell) => {
      if (cell.color === 'transparent') return
      counts.set(cell.color, (counts.get(cell.color) ?? 0) + 1)
    })
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 16)
      .map(([color]) => color)
  },

  drawPattern() {
    const draft = this.data.draft
    if (!draft) return

    wx.createSelectorQuery()
      .in(this)
      .select('#patternCanvas')
      .fields({ node: true, size: true })
      .exec((results) => {
        const result = results[0] as CanvasQueryResult | undefined
        if (!result?.node || !result.width || !result.height) return

        const canvas = result.node
        const context = canvas.getContext('2d')
        const pixelRatio = wx.getWindowInfo().pixelRatio || 1
        canvas.width = Math.round(result.width * pixelRatio)
        canvas.height = Math.round(result.height * pixelRatio)
        context.scale(pixelRatio, pixelRatio)

        context.fillStyle = '#f7f7f7'
        context.fillRect(0, 0, result.width, result.height)

        const columns = draft.settings.width
        const rows = draft.settings.height
        const zoom = this.data.zoom
        const cellWidth = (result.width / columns) * zoom
        const cellHeight = (result.height / rows) * zoom
        const contentWidth = cellWidth * columns
        const contentHeight = cellHeight * rows
        const originX = (result.width - contentWidth) / 2
        const originY = (result.height - contentHeight) / 2
        const radius = Math.min(cellWidth, cellHeight) * 0.44

        draft.cells.forEach((cell, index) => {
          if (cell.color === 'transparent') return
          const column = index % columns
          const row = Math.floor(index / columns)
          const centerX = originX + column * cellWidth + cellWidth / 2
          const centerY = originY + row * cellHeight + cellHeight / 2

          context.globalAlpha = 0.18
          context.fillStyle = '#000000'
          context.beginPath()
          context.arc(
            centerX + cellWidth * 0.06,
            centerY + cellHeight * 0.08,
            radius,
            0,
            Math.PI * 2,
          )
          context.fill()

          context.globalAlpha = 1
          context.fillStyle = cell.color
          context.beginPath()
          context.arc(centerX, centerY, radius, 0, Math.PI * 2)
          context.fill()

          if (radius >= 1.8) {
            context.globalAlpha = 0.34
            context.fillStyle = '#ffffff'
            context.beginPath()
            context.arc(
              centerX - radius * 0.32,
              centerY - radius * 0.34,
              radius * 0.22,
              0,
              Math.PI * 2,
            )
            context.fill()
          }
        })

        context.globalAlpha = 1
      })
  },

  selectTool(event: WechatMiniprogram.TouchEvent) {
    if (event.currentTarget.dataset.disabled) return
    this.setData({ activeTool: String(event.currentTarget.dataset.tool) })
  },

  selectPaletteColor(event: WechatMiniprogram.TouchEvent) {
    this.setData({ selectedColor: String(event.currentTarget.dataset.color) })
  },

  zoomIn() {
    const zoom = Math.min(1.4, Number((this.data.zoom + 0.1).toFixed(1)))
    this.setData({ zoom, zoomPercent: Math.round(zoom * 100) }, () => this.drawPattern())
  },

  zoomOut() {
    const zoom = Math.max(0.8, Number((this.data.zoom - 0.1).toFixed(1)))
    this.setData({ zoom, zoomPercent: Math.round(zoom * 100) }, () => this.drawPattern())
  },

  regenerate() {
    wx.switchTab({ url: '/pages/home/index' })
  },

  saveAndView() {
    const draft = this.data.draft
    if (!draft) return
    appStore.saveWork({
      id: draft.id,
      title: '未命名作品',
      coverPath: draft.sourceImagePath,
      updatedAt: Date.now(),
      beadCount: this.data.beadCount,
      colorCount: draft.settings.colorLimit,
    })
    wx.navigateTo({ url: '/pages/result/index' })
  },
})
