import type { PatternCell, PatternDraft } from '../../models/pattern'
import { appStore } from '../../store/app-store'
import {
  cloudSummaryToWorkItem,
  hasCloudSession,
  saveNewCloudWork,
  updateCloudWork,
} from '../../services/work-service'
import { isNetworkError, queueWorkForSync } from '../../services/work-sync-service'
import { createPendingDraft } from '../../services/image-service'
import {
  AiGenerationFlow,
  type AiGenerationFlowState,
} from '../services/ai-generation-flow'
import { loadAiGenerationSession } from '../../services/ai-generation-session'
import {
  calculateFittedImageSize,
  clampViewTranslation,
  drawPatternViewport,
  editorTools,
  exportPatternCoverImage,
  fillConnectedCells,
  sameCell,
  scaleAroundViewportPoint,
  screenPointToGridCell,
  type CanvasRect,
  type FittedImageSize,
  type GridCell,
  type PatternCanvasContext,
  type ViewTransform,
} from '../services/pattern-editor-service'

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

/** Toast 状态 */
interface ToastState {
  visible: boolean
  message: string
}

const EDIT_HISTORY_LIMIT = 20

/** 缩放范围 */
const SCALE_MIN = 1
const SCALE_MAX = 3
const SCALE_STEP = 0.2
const SCALE_DEFAULT = 1

Page({
  data: {
    draft: null as PatternDraft | null,
    scale: SCALE_DEFAULT,
    scalePercent: 100,
    /** 拼豆图中心相对于 viewport 中心的平移（CSS px） */
    translateX: 0,
    translateY: 0,
    beadCount: 0,
    paletteColors: [] as string[],
    selectedColor: '',
    selectedColorCode: '',
    activeTool: 'pencil',
    saving: false,
    aiFailed: false,
    aiLocked: false,
    aiStateTitle: '',
    aiStateDescription: '',
    aiStatusMessage: '',
    aiWaitingLong: false,
    aiProgress: 60,
    aiRetryMode: 'generation',
    aiShowPurchase: false,
    undoStack: [] as PatternCell[][],
    redoStack: [] as PatternCell[][],
    tools: editorTools(false, false),
    toast: {
      visible: false,
      message: '',
    } as ToastState,
  },

  _viewportRect: null as CanvasRect | null,
  _fittedImage: null as FittedImageSize | null,
  _patternCanvasNode: null as PatternCanvas | null,
  _singleTouchActive: false,
  _blockSingleTouchUntilRelease: false,
  _toastTimer: null as ReturnType<typeof setTimeout> | null,
  _aiFlow: null as AiGenerationFlow | null,

  _isPinching: false,
  /** pinch 开始时两指距离 */
  _pinchStartDist: 0,
  /** pinch 开始时 scale */
  _pinchStartScale: SCALE_DEFAULT,
  /** pinch 开始时视图变换 */
  _pinchStartTransform: { scale: SCALE_DEFAULT, translateX: 0, translateY: 0 } as ViewTransform,
  /** pinch 开始时双指中点（viewport 局部坐标） */
  _pinchStartMidX: 0,
  _pinchStartMidY: 0,

  onLoad(options?: Record<string, string | undefined>) {
    const aiSession = loadAiGenerationSession()
    let draft = appStore.getSnapshot().currentDraft

    const isPendingDraft = draft?.id.startsWith('ai-pending-') === true
    const shouldResumeAiSession = aiSession !== null && (
      aiSession.status === 'processing'
      || aiSession.status === 'succeeded'
      || (aiSession.status === 'creating' && aiSession.inputFileId !== null)
      || (aiSession.status === 'failed' && (!draft || isPendingDraft))
    )

    if (aiSession && shouldResumeAiSession && (!draft || draft.sourceImagePath !== aiSession.sourceImagePath || !isPendingDraft)) {
      draft = createPendingDraft(aiSession.sourceImagePath, aiSession.settings)
      void appStore.setCurrentDraft(draft)
    }
    if (!draft) {
      if (options?.preview === 'generating' || options?.preview === 'ai') {
        this.setData({
          aiLocked: true,
          aiFailed: false,
          aiProgress: 60,
          aiStateTitle: 'AI 正在生成拼豆图',
          aiStateDescription: '预计还需几分钟，请稍候',
        })
        return
      }
      wx.showToast({ title: '请先选择图片', icon: 'none' })
      setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 500)
      return
    }

    const paletteColors = this.getPaletteColors(draft)
    const firstColor = paletteColors[0] ?? ''
    const firstColorCode = firstColor
      ? (draft.cells.find((c) => c.color === firstColor)?.colorCode ?? '')
      : ''
    this.setData({
      draft,
      paletteColors,
      selectedColor: firstColor,
      selectedColorCode: firstColorCode,
      beadCount: draft.cells.filter((cell) => cell.color !== 'transparent').length,
    })

    if (options?.preview === 'generating' || options?.preview === 'ai') {
      this.setData({
        aiLocked: true,
        aiFailed: false,
        aiProgress: 60,
        aiStateTitle: 'AI 正在生成拼豆图',
        aiStateDescription: '预计还需几分钟，请稍候',
      })
      return
    }

    if (aiSession && shouldResumeAiSession && aiSession.sourceImagePath === draft.sourceImagePath && draft.id.startsWith('ai-pending-')) {
      this._aiFlow = new AiGenerationFlow({
        onStateChange: (state) => this.applyAiFlowState(state),
        onDraftReady: (nextDraft) => this.applyAiDraft(nextDraft),
      })
      this.setData({ aiLocked: true })
      this._aiFlow.onShow()
    }
  },

  onShow() {
    this._aiFlow?.onShow()
  },

  onHide() {
    this._aiFlow?.onHide()
  },

  onReady() {
    this.measureViewport(true)
  },

  onResize() {
    this.measureViewport(true)
  },

  onUnload() {
    this._clearToastTimer()
    this._aiFlow?.destroy()
  },

  applyAiFlowState(state: AiGenerationFlowState) {
    const failed = state.pageState === 'failed'
    const progressMap: Record<string, number> = {
      loading: 20,
      uploading: 35,
      submitting: 45,
      queued: 55,
      processing: 60,
      downloading: 80,
      converting: 90,
      failed: 0,
    }
    this.setData({
      aiFailed: failed,
      aiLocked: true,
      aiStateTitle: state.stateTitle || 'AI 正在生成拼豆图',
      aiStateDescription: state.stateDescription || '预计还需几分钟，请稍候',
      aiStatusMessage: state.statusMessage,
      aiWaitingLong: state.waitingLong,
      aiProgress: progressMap[state.pageState] ?? 60,
      aiRetryMode: state.retryMode,
      aiShowPurchase: state.showPurchase,
    })
  },

  async applyAiDraft(nextDraft: PatternDraft): Promise<void> {
    await appStore.setCurrentDraft(nextDraft)
    const paletteColors = this.getPaletteColors(nextDraft)
    const firstColor = paletteColors[0] ?? ''
    const firstColorCode = firstColor
      ? (nextDraft.cells.find((cell) => cell.color === firstColor)?.colorCode ?? '')
      : ''
    this._viewportRect = null
    this._fittedImage = null
    this._patternCanvasNode = null
    this.setData({
      draft: nextDraft,
      paletteColors,
      selectedColor: firstColor,
      selectedColorCode: firstColorCode,
      beadCount: nextDraft.cells.filter((cell) => cell.color !== 'transparent').length,
      aiFailed: false,
      aiLocked: false,
      aiStateTitle: '',
      aiStateDescription: '',
      aiStatusMessage: '',
      aiWaitingLong: false,
      aiShowPurchase: false,
      undoStack: [],
      redoStack: [],
      tools: editorTools(false, false),
      scale: SCALE_DEFAULT,
      scalePercent: 100,
      translateX: 0,
      translateY: 0,
    }, () => this.measureViewport(true))
  },

  retryAiGeneration() {
    void this._aiFlow?.retry()
  },

  purchaseAiGeneration() {
    wx.navigateTo({ url: '/pages-sub/recharge/index' })
  },

  stopWorkspaceTouch() {
    this._singleTouchActive = false
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

  selectTool(event: WechatMiniprogram.TouchEvent) {
    if (this.data.aiLocked) return
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
    if (this.data.aiLocked) return
    const color = String(event.currentTarget.dataset.color)
    const draft = this.data.draft
    const colorCode = draft
      ? (draft.cells.find((c) => c.color === color)?.colorCode ?? '')
      : ''
    this.setData({ selectedColor: color, selectedColorCode: colorCode })
  },

  measureViewport(resetView: boolean) {
    const draft = this.data.draft
    if (!draft) return
    wx.createSelectorQuery()
      .in(this)
      .select('.workspace')
      .fields({ rect: true, size: true })
      .exec((results) => {
        const rect = results[0] as CanvasRect | undefined
        if (!rect?.width || !rect.height) return
        this._viewportRect = rect
        this._patternCanvasNode = null
        const fittedImage = calculateFittedImageSize(
          rect.width,
          rect.height,
          draft.settings.width,
          draft.settings.height,
        )
        this._fittedImage = fittedImage
        this.setData(
          {
            ...(resetView
              ? { scale: SCALE_DEFAULT, scalePercent: 100, translateX: 0, translateY: 0 }
              : {}),
          },
          () => this.drawPattern(),
        )
      })
  },

  drawPattern() {
    const draft = this.data.draft
    const viewport = this._viewportRect
    const image = this._fittedImage
    if (!draft || !viewport || !image) return

    const render = (canvas: PatternCanvas) => {
      drawPatternViewport(
        canvas.getContext('2d'),
        viewport.width,
        viewport.height,
        image,
        {
          scale: this.data.scale,
          translateX: this.data.translateX,
          translateY: this.data.translateY,
        },
        draft,
      )
    }
    if (this._patternCanvasNode) {
      render(this._patternCanvasNode)
      return
    }

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
        canvas.width = Math.round(viewport.width * pixelRatio)
        canvas.height = Math.round(viewport.height * pixelRatio)
        context.scale(pixelRatio, pixelRatio)
        this._patternCanvasNode = canvas
        render(canvas)
      })
  },

  /**
   * 确保固定 viewport 的 rect 已缓存scale/translate 不改变该 rect
   */
  ensureViewportRect(): Promise<CanvasRect> {
    if (this._viewportRect) {
      return Promise.resolve(this._viewportRect)
    }
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('.workspace')
        .fields({ size: true, rect: true })
        .exec((results) => {
          const result = results[0] as CanvasRect | undefined
          if (!result?.width || !result.height) {
            reject(new Error('编辑工作区尚未准备好'))
            return
          }
          this._viewportRect = result
          resolve(result)
        })
    })
  },

  /**
   * 将触点屏幕坐标转换为格子坐标
   */
  async touchToGridCell(x: number, y: number): Promise<GridCell | null> {
    const draft = this.data.draft
    const image = this._fittedImage
    if (!draft || !image) return null
    const viewportRect = await this.ensureViewportRect()
    return screenPointToGridCell(
      x,
      y,
      viewportRect,
      image,
      {
        scale: this.data.scale,
        translateX: this.data.translateX,
        translateY: this.data.translateY,
      },
      draft,
    )
  },

  onWorkspaceTouchStart(event: WechatMiniprogram.TouchEvent) {
    if (this.data.aiLocked) return
    const touches = event.touches
    if (touches.length >= 2) {
      this._beginPinch(touches[0], touches[1])
      return
    }
    if (touches.length === 1 && !this._isPinching && !this._blockSingleTouchUntilRelease) {
      this._singleTouchActive = true
    }
  },

  onWorkspaceTouchMove(event: WechatMiniprogram.TouchEvent) {
    if (this.data.aiLocked) return
    const touches = event.touches
    if (touches.length >= 2) {
      if (!this._isPinching) this._beginPinch(touches[0], touches[1])
      this._updatePinch(touches[0], touches[1])
      return
    }
  },

  onWorkspaceTouchEnd(event: WechatMiniprogram.TouchEvent) {
    if (this.data.aiLocked) return
    const touches = event.touches
    if (this._isPinching) {
      if (touches.length >= 2) return
      this._endPinch()
      this._blockSingleTouchUntilRelease = touches.length > 0
      if (touches.length === 0) this._blockSingleTouchUntilRelease = false
      return
    }
    if (this._blockSingleTouchUntilRelease) {
      if (touches.length === 0) this._blockSingleTouchUntilRelease = false
      return
    }
    if (touches.length > 0) return
    const touch = event.changedTouches[0]
    const shouldExecute = this._singleTouchActive && Boolean(touch)
    this._singleTouchActive = false
    if (shouldExecute && touch) void this.finishSingleTouch(touch.clientX, touch.clientY)
  },

  onWorkspaceTouchCancel() {
    if (this.data.aiLocked) return
    this._singleTouchActive = false
    this._isPinching = false
    this._blockSingleTouchUntilRelease = false
  },

  _pinchDist(t0: WechatMiniprogram.TouchDetail, t1: WechatMiniprogram.TouchDetail): number {
    const dx = t1.clientX - t0.clientX
    const dy = t1.clientY - t0.clientY
    return Math.sqrt(dx * dx + dy * dy)
  },

  _beginPinch(t0: WechatMiniprogram.TouchDetail, t1: WechatMiniprogram.TouchDetail) {
    const viewport = this._viewportRect
    if (!viewport) return
    this._isPinching = true
    this._singleTouchActive = false
    this._blockSingleTouchUntilRelease = true
    this._pinchStartDist = this._pinchDist(t0, t1)
    this._pinchStartScale = this.data.scale
    this._pinchStartTransform = {
      scale: this.data.scale,
      translateX: this.data.translateX,
      translateY: this.data.translateY,
    }
    this._pinchStartMidX = (t0.clientX + t1.clientX) / 2 - viewport.left
    this._pinchStartMidY = (t0.clientY + t1.clientY) / 2 - viewport.top
  },

  _updatePinch(t0: WechatMiniprogram.TouchDetail, t1: WechatMiniprogram.TouchDetail) {
    if (!this._isPinching) return
    const dist = this._pinchDist(t0, t1)
    if (this._pinchStartDist === 0) return

    const viewport = this._viewportRect
    if (!viewport) return
    const rawScale = this._pinchStartScale * (dist / this._pinchStartDist)
    const newScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, rawScale))
    const midX = (t0.clientX + t1.clientX) / 2 - viewport.left
    const midY = (t0.clientY + t1.clientY) / 2 - viewport.top
    const anchored = scaleAroundViewportPoint(
      this._pinchStartTransform,
      newScale,
      this._pinchStartMidX,
      this._pinchStartMidY,
      viewport.width,
      viewport.height,
    )
    const translation = this._clampTranslation(
      anchored.translateX + midX - this._pinchStartMidX,
      anchored.translateY + midY - this._pinchStartMidY,
      newScale,
    )
    this.setData({
      translateX: translation.x,
      translateY: translation.y,
      scale: newScale,
      scalePercent: Math.round(newScale * 100),
    }, () => this.drawPattern())
  },

  _endPinch() {
    this._isPinching = false
  },

  /**
   * 计算合法的 pan 范围，确保图片四角都可以移动到 viewport 中心附近
   * translateX/Y 表示 canvas-stage 相对于 workspace 中心的偏移（CSS px）
   */
  _clampTranslation(translateX: number, translateY: number, scale: number) {
    const viewport = this._viewportRect
    const image = this._fittedImage
    if (!viewport || !image) return { x: 0, y: 0 }
    return clampViewTranslation(
      translateX,
      translateY,
      scale,
      viewport.width,
      viewport.height,
      image,
    )
  },

  async finishSingleTouch(clientX: number, clientY: number) {
    const cell = await this.touchToGridCell(clientX, clientY).catch(() => null)
    if (this._isPinching || this._blockSingleTouchUntilRelease) return
    if (cell) this.executeToolAt(cell)
  },

  executeToolAt(cell: GridCell) {
    const tool = this.data.activeTool
    if (tool === 'pencil' || tool === 'eraser') {
      this._applyPencilOrEraserTap(cell)
      return
    }
    if (tool === 'eyedropper') {
      const draft = this.data.draft
      if (!draft) return
      const pickedCell = draft.cells[cell.index]
      if (!pickedCell || pickedCell.color === 'transparent') return
      this.setData({
        selectedColor: pickedCell.color,
        selectedColorCode: pickedCell.colorCode,
        activeTool: 'pencil',
      })
      this._showToast(`已取色 ${pickedCell.colorCode || pickedCell.color}`)
      return
    }
    if (tool === 'fill') this._applyFill(cell)
  },

  _applyPencilOrEraserTap(cell: GridCell) {
    const draft = this.data.draft
    if (!draft) return
    const currentCell = draft.cells[cell.index]
    if (!currentCell) return
    const tool = this.data.activeTool
    let nextCell: PatternCell
    if (tool === 'eraser') {
      if (currentCell.color === 'transparent') return
      nextCell = { color: 'transparent', colorCode: '' }
    } else {
      const replacement = draft.cells.find((c) => c.color === this.data.selectedColor)
      if (!replacement || sameCell(currentCell, replacement)) return
      nextCell = { ...replacement }
    }
    const nextCells = draft.cells.map((c) => ({ ...c }))
    nextCells[cell.index] = nextCell
    this.commitEdit(nextCells)
  },

  _applyFill(cell: GridCell) {
    const draft = this.data.draft
    if (!draft) return
    const currentCell = draft.cells[cell.index]
    if (!currentCell) return
    const replacement = draft.cells.find((c) => c.color === this.data.selectedColor)
    if (!replacement || sameCell(currentCell, replacement)) return

    const nextCells = draft.cells.map((c) => ({ ...c }))
    fillConnectedCells(
      nextCells,
      cell.index,
      draft.settings.width,
      draft.settings.height,
      currentCell,
      replacement,
    )
    this.commitEdit(nextCells)
  },

  // ─── Undo / Redo ─────────────────────────────────────────────────────────

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
    this.setData(
      {
        draft: updatedDraft,
        undoStack,
        redoStack,
        tools: editorTools(undoStack.length > 0, redoStack.length > 0),
        beadCount: cells.filter((cell) => cell.color !== 'transparent').length,
      },
      () => this.drawPattern(),
    )
  },

  // ─── 缩放（按钮） ─────────────────────────────────────────────────────────

  zoomIn() {
    if (this.data.aiLocked) return
    this._setScaleAtViewportCenter(
      Math.min(SCALE_MAX, Number((this.data.scale + SCALE_STEP).toFixed(1))),
    )
  },

  zoomOut() {
    if (this.data.aiLocked) return
    this._setScaleAtViewportCenter(
      Math.max(SCALE_MIN, Number((this.data.scale - SCALE_STEP).toFixed(1))),
    )
  },

  _setScaleAtViewportCenter(nextScale: number) {
    const viewport = this._viewportRect
    if (!viewport) return
    const anchored = scaleAroundViewportPoint(
      {
        scale: this.data.scale,
        translateX: this.data.translateX,
        translateY: this.data.translateY,
      },
      nextScale,
      viewport.width / 2,
      viewport.height / 2,
      viewport.width,
      viewport.height,
    )
    const translation = this._clampTranslation(
      anchored.translateX,
      anchored.translateY,
      nextScale,
    )
    this.setData(
      {
        scale: nextScale,
        scalePercent: Math.round(nextScale * 100),
        translateX: translation.x,
        translateY: translation.y,
      },
      () => this.drawPattern(),
    )
  },

  // ─── Toast ────────────────────────────────────────────────────────────────

  _showToast(message: string) {
    this._clearToastTimer()
    this.setData({ toast: { visible: true, message } })
    this._toastTimer = setTimeout(() => {
      this.setData({ 'toast.visible': false })
    }, 1800)
  },

  _clearToastTimer() {
    if (this._toastTimer !== null) {
      clearTimeout(this._toastTimer)
      this._toastTimer = null
    }
  },

  // ─── 保存 ─────────────────────────────────────────────────────────────────

  regenerate() {
    wx.switchTab({ url: '/pages/home/index' })
  },

  async saveAndView() {
    if (this.data.saving || this.data.aiLocked) return
    const draft = this.data.draft
    if (!draft) return
    this.setData({ saving: true })
    wx.showLoading({ title: '正在保存', mask: true })
    try {
      const state = appStore.getSnapshot()
      const existing = state.works.find((item) => item.id === draft.id)
      const localWork = {
          id: draft.id,
          title: existing?.title ?? '未命名作品',
          coverPath: draft.sourceImagePath,
          updatedAt: Date.now(),
          createdAt: existing?.createdAt ?? draft.createdAt,
          beadCount: this.data.beadCount,
          colorCount: this.getPaletteColors(draft).length,
          width: draft.settings.width,
          height: draft.settings.height,
          status: 'completed' as const,
          isCloud: false,
      }
      if (!hasCloudSession()) {
        await appStore.saveLocalDraft(draft)
        await appStore.saveWork({ ...localWork, syncStatus: 'guest' })
        wx.showToast({ title: '已保存到本机', icon: 'success' })
      } else {
        const coverPath = await exportPatternCoverImage(draft, this)
        try {
          const summary = existing?.syncStatus === 'synced' || existing?.isCloud
            ? await updateCloudWork(existing.id, draft, coverPath, existing.title)
            : await saveNewCloudWork(draft, coverPath, existing?.title ?? '未命名作品')
          const savedDraft = { ...draft, id: summary.id, sourceImagePath: '' }
          if (existing && existing.id !== summary.id) await appStore.deleteWork(existing.id)
          await appStore.removeLocalDraft(draft.id)
          await appStore.saveWork(cloudSummaryToWorkItem(summary))
          await appStore.setCurrentDraft(savedDraft)
          wx.showToast({ title: '已保存到云端', icon: 'success' })
        } catch (error) {
          const pending = isNetworkError(error)
          await queueWorkForSync({
            ...localWork,
            coverPath,
            syncStatus: pending ? 'pending' : 'failed',
            syncError: error instanceof Error ? error.message : '云端保存失败，请稍后重试',
          }, draft)
          wx.showToast({
            title: pending ? '已保存到本机，联网后自动同步' : '已保存到本机，云端保存失败',
            icon: 'none',
          })
        }
      }
      wx.navigateTo({ url: '/pages-sub/result/index' })
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

})
