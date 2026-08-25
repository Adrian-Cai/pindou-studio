import type { PatternDraft } from '../../models/pattern'
import { appStore } from '../../store/app-store'

type ResultTab = 'preview' | 'materials' | 'chart' | 'palette'

interface MaterialItem {
  color: string
  colorCode: string
  count: number
}

interface ResultSummary {
  title: string
  createdText: string
  beadCount: number
  colorCount: number
}

interface PatternCanvas {
  width: number
  height: number
  getContext(type: '2d'): PatternCanvasContext
}

interface PatternCanvasContext {
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  globalAlpha: number
  font: string
  textAlign: string
  textBaseline: string
  scale(x: number, y: number): void
  fillRect(x: number, y: number, width: number, height: number): void
  strokeRect(x: number, y: number, width: number, height: number): void
  beginPath(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  fill(): void
  fillText(text: string, x: number, y: number): void
}

interface CanvasQueryResult {
  node: PatternCanvas
  width: number
  height: number
}

Page({
  data: {
    draft: null as PatternDraft | null,
    summary: null as ResultSummary | null,
    materials: [] as MaterialItem[],
    activeTab: 'preview' as ResultTab,
    isFavorite: false,
    canvasReady: false,
    renderError: false,
    quota: 0,
    chartWidthRpx: 0,
    chartHeightRpx: 0,
    tabs: [
      { id: 'preview', label: '成品图' },
      { id: 'materials', label: '材料清单' },
      { id: 'chart', label: '施工图' },
      { id: 'palette', label: '色板参考' },
    ],
  },

  onShow() {
    const state = appStore.getSnapshot()
    const draft = state.currentDraft
    const work = draft ? state.works.find((item) => item.id === draft.id) : undefined
    const materials = draft ? summarizeMaterials(draft) : []
    const beadCount = materials.reduce((total, item) => total + item.count, 0)

    this.setData(
      {
        draft,
        materials,
        quota: state.downloadQuota,
        isFavorite: draft ? state.favoriteIds.includes(draft.id) : false,
        summary: draft
          ? {
              title: work?.title ?? '未命名作品',
              createdText: formatDateTime(draft.createdAt),
              beadCount,
              colorCount: materials.length,
            }
          : null,
        chartWidthRpx: draft ? draft.settings.width * 32 : 0,
        chartHeightRpx: draft ? draft.settings.height * 32 : 0,
      },
      () => {
        if (this.data.canvasReady) this.renderVisibleCanvases()
      },
    )
  },

  onReady() {
    this.setData({ canvasReady: true }, () => this.renderVisibleCanvases())
  },

  changeTab(event: WechatMiniprogram.TouchEvent) {
    const activeTab = String(event.currentTarget.dataset.tab) as ResultTab
    if (activeTab === this.data.activeTab) return
    this.setData({ activeTab, renderError: false }, () => this.renderVisibleCanvases())
  },

  toggleFavorite() {
    const draft = this.data.draft
    if (!draft) return
    appStore.toggleFavorite(draft.id)
    this.setData({ isFavorite: !this.data.isFavorite })
  },

  openMore() {
    wx.showActionSheet({
      itemList: ['返回作品列表', '重新制作'],
      success: ({ tapIndex }) => {
        const url = tapIndex === 0 ? '/pages/projects/index' : '/pages/home/index'
        wx.switchTab({ url })
      },
    })
  },

  openDownloads() {
    wx.navigateTo({ url: '/pages/downloads/index' })
  },

  goCreate() {
    wx.switchTab({ url: '/pages/home/index' })
  },

  switchMainTab(event: WechatMiniprogram.TouchEvent) {
    wx.switchTab({ url: String(event.currentTarget.dataset.path) })
  },

  async renderVisibleCanvases() {
    const draft = this.data.draft
    if (!draft || !this.data.canvasReady) return

    try {
      const jobs: Promise<void>[] = [this.drawBeadCanvas('#thumbnailCanvas', draft)]
      if (this.data.activeTab === 'preview') {
        jobs.push(this.drawBeadCanvas('#previewCanvas', draft))
      }
      if (this.data.activeTab === 'chart') {
        jobs.push(this.drawChartCanvas('#chartCanvas', draft))
      }
      await Promise.all(jobs)
      if (this.data.renderError) this.setData({ renderError: false })
    } catch (error) {
      console.error('作品图渲染失败', error)
      this.setData({ renderError: true })
    }
  },

  async drawBeadCanvas(selector: string, draft: PatternDraft) {
    const result = await this.queryCanvas(selector)
    const pixelRatio = Math.min(wx.getWindowInfo().pixelRatio || 1, 2)
    const canvas = result.node
    canvas.width = Math.round(result.width * pixelRatio)
    canvas.height = Math.round(result.height * pixelRatio)

    const context = canvas.getContext('2d')
    context.scale(pixelRatio, pixelRatio)
    context.fillStyle = '#f7f7f9'
    context.fillRect(0, 0, result.width, result.height)

    const cellWidth = result.width / draft.settings.width
    const cellHeight = result.height / draft.settings.height
    const radius = Math.min(cellWidth, cellHeight) * 0.43

    draft.cells.forEach((cell, index) => {
      if (cell.color === 'transparent') return
      const column = index % draft.settings.width
      const row = Math.floor(index / draft.settings.width)
      const centerX = column * cellWidth + cellWidth / 2
      const centerY = row * cellHeight + cellHeight / 2

      context.globalAlpha = 0.16
      context.fillStyle = '#111111'
      context.beginPath()
      context.arc(centerX + radius * 0.1, centerY + radius * 0.14, radius, 0, Math.PI * 2)
      context.fill()

      context.globalAlpha = 1
      context.fillStyle = cell.color
      context.beginPath()
      context.arc(centerX, centerY, radius, 0, Math.PI * 2)
      context.fill()

      if (radius >= 1.7) {
        context.globalAlpha = 0.35
        context.fillStyle = '#ffffff'
        context.beginPath()
        context.arc(centerX - radius * 0.3, centerY - radius * 0.32, radius * 0.2, 0, Math.PI * 2)
        context.fill()
      }
    })
    context.globalAlpha = 1
  },

  async drawChartCanvas(selector: string, draft: PatternDraft) {
    const result = await this.queryCanvas(selector)
    const canvas = result.node
    canvas.width = Math.round(result.width)
    canvas.height = Math.round(result.height)

    const context = canvas.getContext('2d')
    const cellWidth = result.width / draft.settings.width
    const cellHeight = result.height / draft.settings.height
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, result.width, result.height)
    context.lineWidth = 0.5
    context.strokeStyle = '#d9d9d9'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.font = `${Math.max(7, Math.min(10, cellWidth * 0.52))}px sans-serif`

    draft.cells.forEach((cell, index) => {
      const column = index % draft.settings.width
      const row = Math.floor(index / draft.settings.width)
      const x = column * cellWidth
      const y = row * cellHeight
      context.fillStyle = cell.color === 'transparent' ? '#ffffff' : cell.color
      context.fillRect(x, y, cellWidth, cellHeight)
      context.strokeRect(x, y, cellWidth, cellHeight)

      if (cell.colorCode) {
        context.fillStyle = getTextColor(cell.color)
        context.fillText(cell.colorCode.replace(/^C0?/, ''), x + cellWidth / 2, y + cellHeight / 2)
      }
    })
  },

  queryCanvas(selector: string): Promise<CanvasQueryResult> {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select(selector)
        .fields({ node: true, size: true })
        .exec((results) => {
          const result = results[0] as CanvasQueryResult | undefined
          if (!result?.node || !result.width || !result.height) {
            reject(new Error(`未找到画布 ${selector}`))
            return
          }
          resolve(result)
        })
    })
  },

  onShareAppMessage() {
    return {
      title: '看看我刚生成的拼豆图纸',
      path: '/pages/home/index',
    }
  },
})

function summarizeMaterials(draft: PatternDraft): MaterialItem[] {
  const materials = new Map<string, MaterialItem>()
  draft.cells.forEach((cell) => {
    if (cell.color === 'transparent' || !cell.colorCode) return
    const key = `${cell.colorCode}-${cell.color}`
    const current = materials.get(key)
    if (current) {
      current.count += 1
      return
    }
    materials.set(key, { color: cell.color, colorCode: cell.colorCode, count: 1 })
  })
  return [...materials.values()].sort((left, right) => right.count - left.count)
}

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

function getTextColor(hex: string): string {
  const normalized = hex.replace('#', '')
  if (normalized.length !== 6) return '#111111'
  const red = Number.parseInt(normalized.slice(0, 2), 16)
  const green = Number.parseInt(normalized.slice(2, 4), 16)
  const blue = Number.parseInt(normalized.slice(4, 6), 16)
  return red * 0.299 + green * 0.587 + blue * 0.114 > 156 ? '#111111' : '#ffffff'
}
