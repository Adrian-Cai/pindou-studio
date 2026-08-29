import type { PatternCell, PatternDraft } from '../../models/pattern'
import { appStore } from '../../store/app-store'
import {
  cloudSummaryToWorkItem,
  hasCloudSession,
  saveNewCloudWork,
  updateCloudWork,
} from '../../services/work-service'
import {
  drawPatternOnCanvas,
  editorTools,
  fillConnectedCells,
  getCellIndexAtPoint,
  sameCell,
  type PatternCanvasContext,
} from '../../services/pattern-editor-service'

interface PatternCanvas {
  width: number
  height: number
  getContext(type: '2d'): PatternCanvasContext
}

interface CanvasQueryResult {
  node: PatternCanvas
  width: number
  height: number
}

interface CanvasRectQueryResult extends CanvasQueryResult {
  left: number
  top: number
}

const EDIT_HISTORY_LIMIT = 20

Page({
  data: {
    draft: null as PatternDraft | null,
    zoom: 1,
    zoomPercent: 100,
    beadCount: 0,
    paletteColors: [] as string[],
    selectedColor: '',
    activeTool: 'fill',
    saving: false,
    undoStack: [] as PatternCell[][],
    redoStack: [] as PatternCell[][],
    tools: editorTools(false, false),
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

        drawPatternOnCanvas(context, result.width, result.height, draft, this.data.zoom)
      })
  },

  selectTool(event: WechatMiniprogram.TouchEvent) {
    if (event.currentTarget.dataset.disabled) return
    const tool = String(event.currentTarget.dataset.tool)
    if (tool === 'undo') {
      this.undoEdit()
      return
    }
    if (tool === 'redo') {
      this.redoEdit()
      return
    }
    this.setData({ activeTool: tool })
  },

  selectPaletteColor(event: WechatMiniprogram.TouchEvent) {
    this.setData({ selectedColor: String(event.currentTarget.dataset.color) })
  },

  async editPattern(event: WechatMiniprogram.TouchEvent) {
    const draft = this.data.draft
    const touch = event.changedTouches[0]
    if (!draft || !touch) return
    const canvas = await this.queryPatternCanvasRect()
    const cellIndex = getCellIndexAtPoint(
      touch.clientX - canvas.left,
      touch.clientY - canvas.top,
      canvas.width,
      canvas.height,
      draft,
      this.data.zoom,
    )
    if (cellIndex < 0) return

    const currentCell = draft.cells[cellIndex]
    if (!currentCell) return
    if (this.data.activeTool === 'eyedropper') {
      if (currentCell.color !== 'transparent') {
        this.setData({ selectedColor: currentCell.color, activeTool: 'fill' })
      }
      return
    }

    const nextCells = draft.cells.map((cell) => ({ ...cell }))
    if (this.data.activeTool === 'eraser') {
      if (currentCell.color === 'transparent') return
      nextCells[cellIndex] = { color: 'transparent', colorCode: '' }
    } else {
      const replacement = draft.cells.find((cell) => cell.color === this.data.selectedColor)
      if (!replacement || sameCell(currentCell, replacement)) return
      fillConnectedCells(
        nextCells,
        cellIndex,
        draft.settings.width,
        draft.settings.height,
        currentCell,
        replacement,
      )
    }
    this.commitEdit(nextCells)
  },

  commitEdit(cells: PatternCell[]) {
    const draft = this.data.draft
    if (!draft) return
    const undoStack = [...this.data.undoStack, draft.cells.map((cell) => ({ ...cell }))]
      .slice(-EDIT_HISTORY_LIMIT)
    this.applyEditedCells(cells, undoStack, [])
  },

  undoEdit() {
    const draft = this.data.draft
    const previous = this.data.undoStack[this.data.undoStack.length - 1]
    if (!draft || !previous) return
    const undoStack = this.data.undoStack.slice(0, -1)
    const redoStack = [...this.data.redoStack, draft.cells.map((cell) => ({ ...cell }))]
      .slice(-EDIT_HISTORY_LIMIT)
    this.applyEditedCells(previous, undoStack, redoStack)
  },

  redoEdit() {
    const draft = this.data.draft
    const next = this.data.redoStack[this.data.redoStack.length - 1]
    if (!draft || !next) return
    const undoStack = [...this.data.undoStack, draft.cells.map((cell) => ({ ...cell }))]
      .slice(-EDIT_HISTORY_LIMIT)
    const redoStack = this.data.redoStack.slice(0, -1)
    this.applyEditedCells(next, undoStack, redoStack)
  },

  applyEditedCells(cells: PatternCell[], undoStack: PatternCell[][], redoStack: PatternCell[][]) {
    const draft = this.data.draft
    if (!draft) return
    const updatedDraft = { ...draft, cells: cells.map((cell) => ({ ...cell })) }
    appStore.setCurrentDraft(updatedDraft)
    this.setData({
      draft: updatedDraft,
      undoStack,
      redoStack,
      tools: editorTools(undoStack.length > 0, redoStack.length > 0),
      beadCount: cells.filter((cell) => cell.color !== 'transparent').length,
    }, () => this.drawPattern())
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

  async saveAndView() {
    if (this.data.saving) return
    const draft = this.data.draft
    if (!draft) return
    this.setData({ saving: true })
    wx.showLoading({ title: '正在保存', mask: true })
    try {
      const state = appStore.getSnapshot()
      const existing = state.works.find((item) => item.id === draft.id)
      if (hasCloudSession()) {
        const coverPath = await this.exportPatternCover()
        const summary = existing?.isCloud
          ? await updateCloudWork(existing.id, draft, coverPath, existing.title)
          : await saveNewCloudWork(draft, coverPath, existing?.title ?? '未命名作品')
        const savedDraft = { ...draft, id: summary.id, sourceImagePath: '' }
        if (existing && existing.id !== summary.id) appStore.deleteWork(existing.id)
        appStore.setCurrentDraft(savedDraft)
        appStore.saveWork(cloudSummaryToWorkItem(summary))
      } else {
        appStore.saveWork({
          id: draft.id,
          title: existing?.title ?? '未命名作品',
          coverPath: draft.sourceImagePath,
          updatedAt: Date.now(),
          createdAt: existing?.createdAt ?? draft.createdAt,
          beadCount: this.data.beadCount,
          colorCount: this.getPaletteColors(draft).length,
          width: draft.settings.width,
          height: draft.settings.height,
          status: 'completed',
          isCloud: false,
        })
      }
      wx.navigateTo({ url: '/pages/result/index' })
    } catch (error) {
      console.error('保存作品失败', error)
      wx.showToast({
        title: error instanceof Error ? error.message : '保存失败，请重试',
        icon: 'none',
      })
    } finally {
      wx.hideLoading()
      this.setData({ saving: false })
    }
  },

  async exportPatternCover(): Promise<string> {
    const result = await this.queryPatternCanvas()
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath(
        {
          canvas: result.node as unknown as WechatMiniprogram.Canvas,
          fileType: 'png',
          quality: 1,
          success: ({ tempFilePath }) => resolve(tempFilePath),
          fail: (error) => reject(new Error(error.errMsg || '封面生成失败')),
        },
        this,
      )
    })
  },

  queryPatternCanvas(): Promise<CanvasQueryResult> {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#patternCanvas')
        .fields({ node: true, size: true })
        .exec((results) => {
          const result = results[0] as CanvasQueryResult | undefined
          if (!result?.node || !result.width || !result.height) {
            reject(new Error('作品画布尚未准备好'))
            return
          }
          resolve(result)
        })
    })
  },

  queryPatternCanvasRect(): Promise<CanvasRectQueryResult> {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#patternCanvas')
        .fields({ node: true, size: true, rect: true })
        .exec((results) => {
          const result = results[0] as CanvasRectQueryResult | undefined
          if (!result?.node || !result.width || !result.height) {
            reject(new Error('作品画布尚未准备好'))
            return
          }
          resolve(result)
        })
    })
  },
})
