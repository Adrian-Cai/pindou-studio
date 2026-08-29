import type { PatternDraft, WorkItem } from '../../models/pattern'
import { cloudSummaryToWorkItem, renameCloudWork } from '../../services/work-service'
import { appStore } from '../../store/app-store'
import { getCustomNavigationMetrics } from '../../utils/navigation'

type ResultTab = 'preview' | 'materials' | 'chart' | 'palette'

interface MaterialItem {
  color: string
  colorCode: string
  count: number
  percentage: string
}

const MATERIAL_PREVIEW_LIMIT = 5

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
    visibleMaterials: [] as MaterialItem[],
    materialListExpanded: false,
    activeTab: 'preview' as ResultTab,
    isFavorite: false,
    canvasReady: false,
    renderError: false,
    quota: 0,
    chartWidthRpx: 0,
    chartHeightRpx: 0,
    thumbnailSrc: '' as string,
    previewSrc: '' as string,
    chartSrc: '' as string,
    patternImagesRendering: false,
    chartImageRendering: false,
    renamingTitle: false,
    renderedDraftKey: '',
    navigationBarHeight: 0,
    topBarHeight: 0,
    scrollAreaHeight: 0,
    tabs: [
      { id: 'preview', label: '成品图' },
      { id: 'materials', label: '材料清单' },
      { id: 'chart', label: '施工图' },
      { id: 'palette', label: '色板参考' },
    ],
  },

  onLoad() {
    this.updateLayoutMetrics()
  },

  onShow() {
    const state = appStore.getSnapshot()
    const draft = state.currentDraft
    const work = draft ? state.works.find((item) => item.id === draft.id) : undefined
    const materials = draft ? summarizeMaterials(draft) : []
    const beadCount = materials.reduce((total, item) => total + item.count, 0)
    const materialListExpanded = materials.length > MATERIAL_PREVIEW_LIMIT
      && this.data.draft?.id === draft?.id
      && this.data.materialListExpanded
    const draftRenderKey = draft ? createDraftRenderKey(draft) : ''
    const shouldRenderPatternImages = draftRenderKey !== this.data.renderedDraftKey

    this.setData(
      {
        draft,
        materials,
        visibleMaterials: materialListExpanded
          ? materials
          : materials.slice(0, MATERIAL_PREVIEW_LIMIT),
        materialListExpanded,
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
        renderedDraftKey: draftRenderKey,
        ...(shouldRenderPatternImages ? { thumbnailSrc: '', previewSrc: '', chartSrc: '' } : {}),
      },
      () => {
        if (this.data.canvasReady) this.renderVisibleCanvases()
      },
    )
  },

  onReady() {
    this.setData({ canvasReady: true }, () => this.renderVisibleCanvases())
  },

  onResize() {
    this.updateLayoutMetrics()
  },

  updateLayoutMetrics() {
    const metrics = getCustomNavigationMetrics()
    this.setData({
      navigationBarHeight: metrics.navigationBarHeight,
      topBarHeight: metrics.topBarHeight,
      scrollAreaHeight: Math.max(0, metrics.windowHeight - metrics.topBarHeight),
    })
  },

  changeTab(event: WechatMiniprogram.TouchEvent) {
    const activeTab = String(event.currentTarget.dataset.tab) as ResultTab
    if (activeTab === this.data.activeTab) return
    this.setData({ activeTab, renderError: false }, () => this.renderVisibleCanvases())
  },

  toggleMaterialList() {
    const materialListExpanded = !this.data.materialListExpanded
    this.setData({
      materialListExpanded,
      visibleMaterials: materialListExpanded
        ? this.data.materials
        : this.data.materials.slice(0, MATERIAL_PREVIEW_LIMIT),
    })
  },

  toggleFavorite() {
    const draft = this.data.draft
    if (!draft) return
    appStore.toggleFavorite(draft.id)
    this.setData({ isFavorite: !this.data.isFavorite })
  },

  editTitle() {
    if (this.data.renamingTitle) return
    const draft = this.data.draft
    const summary = this.data.summary
    if (!draft || !summary) return

    const work = appStore.getSnapshot().works.find((item) => item.id === draft.id)
    if (!work) {
      wx.showToast({ title: '作品记录不存在，请返回后重试', icon: 'none' })
      return
    }

    wx.showModal({
      title: '编辑作品名称',
      content: summary.title,
      editable: true,
      placeholderText: '请输入作品名称',
      confirmText: '保存',
      success: ({ confirm, content }) => {
        if (!confirm) return
        const nextTitle = content.trim()
        if (!nextTitle) {
          wx.showToast({ title: '作品名称不能为空', icon: 'none' })
          return
        }
        if (Array.from(nextTitle).length > 120) {
          wx.showToast({ title: '作品名称不能超过 120 个字符', icon: 'none' })
          return
        }
        if (/[\u0000-\u001f\u007f]/u.test(nextTitle)) {
          wx.showToast({ title: '作品名称包含不可用字符', icon: 'none' })
          return
        }
        if (nextTitle === summary.title) return
        void this.persistTitleRename(work, nextTitle)
      },
    })
  },

  async persistTitleRename(work: WorkItem, title: string) {
    if (this.data.renamingTitle) return
    this.setData({ renamingTitle: true })
    wx.showLoading({ title: '正在保存', mask: true })
    try {
      let savedTitle = title
      if (work.isCloud) {
        const savedWork = await renameCloudWork(work.id, title)
        savedTitle = savedWork.title
        appStore.saveWork(cloudSummaryToWorkItem(savedWork))
      } else {
        appStore.saveWork({ ...work, title, updatedAt: Date.now() })
      }

      const summary = this.data.summary
      if (summary) this.setData({ summary: { ...summary, title: savedTitle } })
      wx.hideLoading()
      wx.showToast({ title: '作品名称已保存', icon: 'success' })
    } catch (error) {
      console.error('保存作品名称失败', error)
      wx.hideLoading()
      wx.showToast({
        title: error instanceof Error ? error.message : '保存失败，请重试',
        icon: 'none',
      })
    } finally {
      this.setData({ renamingTitle: false })
    }
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
      const jobs: Promise<void>[] = []
      if (
        (!this.data.thumbnailSrc || !this.data.previewSrc)
        && !this.data.patternImagesRendering
      ) {
        jobs.push(this.renderPatternImages(draft))
      }
      if (
        this.data.activeTab === 'chart'
        && !this.data.chartSrc
        && !this.data.chartImageRendering
      ) {
        jobs.push(this.drawChartImage(draft))
      }
      await Promise.all(jobs)
      if (this.data.renderError) this.setData({ renderError: false })
    } catch (error) {
      console.error('作品图渲染失败', error)
      this.setData({ renderError: true })
    }
  },

  async renderPatternImages(draft: PatternDraft) {
    this.setData({ patternImagesRendering: true })
    try {
      await Promise.all([this.drawThumbnail(draft), this.drawPreviewImage(draft)])
    } finally {
      this.setData({ patternImagesRendering: false })
    }
  },

  async drawThumbnail(draft: PatternDraft) {
    // type="2d" canvas 仅用于离屏绘制，绘完后导出为临时图片由 <image> 展示
    // 避免原生 canvas 组件脱离文档流导致滚动时漂移
    const THUMB_SIZE_PX = Math.round((144 / 750) * wx.getWindowInfo().windowWidth)
    const pixelRatio = Math.min(wx.getWindowInfo().pixelRatio || 1, 2)

    // 先获取 canvas node（必须通过 queryCanvas 查询 in(this)）
    const canvasNode = await new Promise<PatternCanvas>((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#thumbnailCanvas')
        .fields({ node: true })
        .exec((results: [{ node?: PatternCanvas } | undefined]) => {
          const node = results[0]?.node
          if (!node) {
            reject(new Error('thumbnailCanvas not found'))
            return
          }
          resolve(node)
        })
    })

    // 手动设置 canvas 分辨率（不依赖 CSS 布局尺寸）
    const drawSize = THUMB_SIZE_PX
    canvasNode.width = Math.round(drawSize * pixelRatio)
    canvasNode.height = Math.round(drawSize * pixelRatio)

    const context = canvasNode.getContext('2d')
    context.scale(pixelRatio, pixelRatio)
    context.fillStyle = '#f7f7f9'
    context.fillRect(0, 0, drawSize, drawSize)

    const cellWidth = drawSize / draft.settings.width
    const cellHeight = drawSize / draft.settings.height
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
        context.arc(
          centerX - radius * 0.3,
          centerY - radius * 0.32,
          radius * 0.2,
          0,
          Math.PI * 2,
        )
        context.fill()
      }
    })
    context.globalAlpha = 1

    const tempFilePath = await new Promise<string>((resolve, reject) => {
      wx.canvasToTempFilePath(
        {
          canvas: canvasNode as unknown as WechatMiniprogram.Canvas,
          fileType: 'png' as const,
          quality: 1,
          success: (res: WechatMiniprogram.CanvasToTempFilePathSuccessCallbackResult) =>
            resolve(res.tempFilePath),
          fail: (err: WechatMiniprogram.GeneralCallbackResult) => reject(new Error(err.errMsg)),
        },
        this,
      )
    })
    this.setData({ thumbnailSrc: tempFilePath })
  },

  async drawPreviewImage(draft: PatternDraft) {
    const canvas = await this.drawBeadCanvas('#previewRenderCanvas', draft)
    const tempFilePath = await this.exportCanvas(canvas)
    this.setData({ previewSrc: tempFilePath })
  },

  async drawBeadCanvas(selector: string, draft: PatternDraft): Promise<PatternCanvas> {
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
    return canvas
  },

  exportCanvas(canvas: PatternCanvas): Promise<string> {
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath(
        {
          canvas: canvas as unknown as WechatMiniprogram.Canvas,
          fileType: 'png',
          quality: 1,
          success: ({ tempFilePath }) => resolve(tempFilePath),
          fail: (error) => reject(new Error(error.errMsg || '图片生成失败')),
        },
        this,
      )
    })
  },

  async drawChartImage(draft: PatternDraft) {
    this.setData({ chartImageRendering: true })
    try {
      const canvas = await this.drawChartCanvas('#chartRenderCanvas', draft)
      const tempFilePath = await this.exportCanvas(canvas)
      this.setData({ chartSrc: tempFilePath })
    } finally {
      this.setData({ chartImageRendering: false })
    }
  },

  async drawChartCanvas(selector: string, draft: PatternDraft): Promise<PatternCanvas> {
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
    return canvas
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
  const materials = new Map<string, Omit<MaterialItem, 'percentage'>>()
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
  const materialList = [...materials.values()]
  const totalCount = materialList.reduce((total, item) => total + item.count, 0)
  return materialList
    .sort((left, right) => right.count - left.count)
    .map((item) => ({
      ...item,
      percentage: `${((item.count / totalCount) * 100).toFixed(1)}%`,
    }))
}

function createDraftRenderKey(draft: PatternDraft): string {
  let hash = 2166136261
  draft.cells.forEach((cell) => {
    const value = `${cell.color}:${cell.colorCode};`
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
  })
  return `${draft.id}:${draft.settings.width}x${draft.settings.height}:${hash >>> 0}`
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
