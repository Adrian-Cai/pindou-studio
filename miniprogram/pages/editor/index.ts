import type { PatternCell, PatternDraft } from '../../models/pattern'
import { appStore } from '../../store/app-store'
import {
  cloudSummaryToWorkItem,
  hasCloudSession,
  saveNewCloudWork,
  updateCloudWork,
} from '../../services/work-service'
import {
  drawMagnifier,
  drawPatternOnCanvas,
  editorTools,
  fillConnectedCells,
  sameCell,
  screenPointToGridCell,
  type CanvasRect,
  type GridCell,
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

/** 放大镜状态 */
interface MagnifierState {
  visible: boolean
  /** 放大镜左上角相对于页面的 CSS 像素位置 */
  top: number
  left: number
  row: number
  column: number
}

/** Toast 状态 */
interface ToastState {
  visible: boolean
  message: string
}

/** 编辑 stroke 期间的中间状态（不进入 setData，只在内存维护） */
interface StrokeState {
  /** stroke 开始时的 cells 快照，用于 undo */
  snapshot: PatternCell[]
  /** 本次 stroke 已修改过的 cell index 集合，避免重复修改同一格 */
  visited: Set<number>
  /** 是否产生了实际修改 */
  dirty: boolean
}

const EDIT_HISTORY_LIMIT = 20
/** 放大镜 CSS 边长（px） */
const MAG_SIZE = 140
/** 放大镜默认显示的半径格数（3 → 7×7） */
const MAG_HALF_GRID = 3
/** 放大镜在手指上方的偏移量（CSS px） */
const MAG_OFFSET_ABOVE = 120
/** 放大镜切换到手指下方的触发阈值（屏幕顶距 < 此值时切换） */
const MAG_FLIP_THRESHOLD = 180
/** 放大镜在手指下方的偏移量（CSS px） */
const MAG_OFFSET_BELOW = 80

/** 缩放范围 */
const ZOOM_MIN = 0.5
const ZOOM_MAX = 1.8
const ZOOM_STEP = 0.1
const ZOOM_DEFAULT = 1.0

/** 画布尺寸（CSS px），正方形 */
const CANVAS_CSS_SIZE = 280

Page({
  data: {
    draft: null as PatternDraft | null,
    zoom: ZOOM_DEFAULT,
    zoomPercent: 100,
    /** 画布平移（CSS px，相对于 workspace 中心） */
    panX: 0,
    panY: 0,
    beadCount: 0,
    paletteColors: [] as string[],
    selectedColor: '',
    selectedColorCode: '',
    activeTool: 'pencil',
    saving: false,
    undoStack: [] as PatternCell[][],
    redoStack: [] as PatternCell[][],
    tools: editorTools(false, false),
    magnifier: {
      visible: false,
      top: 0,
      left: 0,
      row: 0,
      column: 0,
    } as MagnifierState,
    toast: {
      visible: false,
      message: '',
    } as ToastState,
  },

  // ─── 内部状态（不需要响应式） ─────────────────────────────────────────────
  /** 缓存的 canvas 位置信息，zoom/pan 变化时清除 */
  _canvasRect: null as CanvasRect | null,
  /** 放大镜 canvas node（缓存避免重复查询） */
  _magCanvasNode: null as PatternCanvas | null,
  /** 当前 stroke 状态 */
  _stroke: null as StrokeState | null,
  /** RAF 节流：上一帧的 touch 坐标 */
  _pendingTouch: null as { x: number; y: number } | null,
  /** RAF handle */
  _rafHandle: null as number | null,
  /** Toast 定时器 */
  _toastTimer: null as ReturnType<typeof setTimeout> | null,

  // ─── Pinch 手势内部状态 ───────────────────────────────────────────────────
  /** 是否正在双指手势中 */
  _isPinching: false,
  /** pinch 开始时两指距离 */
  _pinchStartDist: 0,
  /** pinch 开始时 zoom */
  _pinchStartZoom: ZOOM_DEFAULT,
  /** pinch 开始时 panX */
  _pinchStartPanX: 0,
  /** pinch 开始时 panY */
  _pinchStartPanY: 0,
  /** pinch 开始时双指中点（clientX） */
  _pinchStartMidX: 0,
  /** pinch 开始时双指中点（clientY） */
  _pinchStartMidY: 0,
  /** workspace 在屏幕上的中点（用于坐标转换） */
  _workspaceCenterX: 0,
  _workspaceCenterY: 0,
  /** 节流：上一次 setData 的时间戳 */
  _lastPanSetDataTs: 0,

  // ─── 生命周期 ─────────────────────────────────────────────────────────────

  onLoad() {
    const draft = appStore.getSnapshot().currentDraft
    if (!draft) {
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
  },

  onReady() {
    // 查询 workspace 尺寸，缓存中心点（用于 pan 边界计算）
    wx.createSelectorQuery()
      .in(this)
      .select('.workspace')
      .fields({ rect: true })
      .exec((results: any[]) => {
        const r = results[0]
        if (r) {
          this._workspaceCenterX = r.left + r.width / 2
          this._workspaceCenterY = r.top + r.height / 2
        }
        this.drawPattern()
      })
  },

  onUnload() {
    this._clearRaf()
    this._clearToastTimer()
  },

  // ─── 调色板 & 工具选择 ────────────────────────────────────────────────────

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
    const color = String(event.currentTarget.dataset.color)
    const draft = this.data.draft
    const colorCode = draft
      ? (draft.cells.find((c) => c.color === color)?.colorCode ?? '')
      : ''
    this.setData({ selectedColor: color, selectedColorCode: colorCode })
  },

  // ─── 画布绘制 ─────────────────────────────────────────────────────────────

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

  // ─── 坐标映射 ─────────────────────────────────────────────────────────────

  /**
   * 确保 canvasRect 已缓存。第一次调用时通过 SelectorQuery 查询并缓存。
   * zoom/pan 变化时调用 _invalidateCanvasRect() 清除缓存。
   *
   * 注意：canvas-stage 使用 CSS transform，SelectorQuery 拿到的 rect
   * 已经是 transform 后的实际屏幕坐标，因此坐标转换无需额外修正 panX/panY。
   */
  ensureCanvasRect(): Promise<CanvasRect> {
    if (this._canvasRect) {
      return Promise.resolve(this._canvasRect)
    }
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
          this._canvasRect = {
            left: result.left,
            top: result.top,
            width: result.width,
            height: result.height,
          }
          resolve(this._canvasRect)
        })
    })
  },

  _invalidateCanvasRect() {
    this._canvasRect = null
  },

  /**
   * 将触点屏幕坐标转换为格子坐标
   */
  async touchToGridCell(x: number, y: number): Promise<GridCell | null> {
    const draft = this.data.draft
    if (!draft) return null
    const rect = await this.ensureCanvasRect()
    return screenPointToGridCell(x, y, rect, draft, this.data.zoom)
  },

  // ─── 放大镜 ───────────────────────────────────────────────────────────────

  getMagCanvasNode(): Promise<PatternCanvas> {
    if (this._magCanvasNode) {
      return Promise.resolve(this._magCanvasNode)
    }
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#magnifierCanvas')
        .fields({ node: true, size: true })
        .exec((results) => {
          const result = results[0] as CanvasQueryResult | undefined
          if (!result?.node) {
            reject(new Error('放大镜 canvas 未找到'))
            return
          }
          const canvas = result.node
          const pixelRatio = wx.getWindowInfo().pixelRatio || 1
          canvas.width = Math.round(MAG_SIZE * pixelRatio)
          canvas.height = Math.round(MAG_SIZE * pixelRatio)
          const ctx = canvas.getContext('2d')
          ctx.scale(pixelRatio, pixelRatio)
          this._magCanvasNode = canvas
          resolve(canvas)
        })
    })
  },

  calcMagPosition(touchClientX: number, touchClientY: number): { top: number; left: number } {
    const screenWidth = wx.getWindowInfo().windowWidth
    let top: number
    if (touchClientY < MAG_FLIP_THRESHOLD) {
      top = touchClientY + MAG_OFFSET_BELOW
    } else {
      top = touchClientY - MAG_OFFSET_ABOVE - MAG_SIZE
    }
    let left = touchClientX - MAG_SIZE / 2
    left = Math.max(8, Math.min(screenWidth - MAG_SIZE - 8, left))
    return { top: Math.max(8, top), left }
  },

  async updateMagnifierAt(touchClientX: number, touchClientY: number, cell: GridCell) {
    const draft = this.data.draft
    if (!draft) return

    const pos = this.calcMagPosition(touchClientX, touchClientY)

    this.setData({
      'magnifier.visible': true,
      'magnifier.top': pos.top,
      'magnifier.left': pos.left,
      'magnifier.row': cell.row,
      'magnifier.column': cell.column,
    })

    try {
      const magCanvas = await this.getMagCanvasNode()
      const magCtx = magCanvas.getContext('2d')
      drawMagnifier(magCtx, MAG_SIZE, cell.row, cell.column, draft, MAG_HALF_GRID)
    } catch {
      // 放大镜渲染失败不阻断主流程
    }
  },

  hideMagnifier() {
    this.setData({ 'magnifier.visible': false })
  },

  // ─── 工作区手势入口（单指 / 双指分发） ───────────────────────────────────

  onWorkspaceTouchStart(event: WechatMiniprogram.TouchEvent) {
    const touches = event.touches
    if (touches.length >= 2) {
      // 双指：进入 pinch 模式，取消任何进行中的单指 stroke
      this._cancelStroke()
      this._clearRaf()
      this._pendingTouch = null
      this._beginPinch(touches[0], touches[1])
    } else if (touches.length === 1 && !this._isPinching) {
      // 单指且不在 pinch 中：绘制
      void this._handleDrawTouchStart(touches[0])
    }
  },

  onWorkspaceTouchMove(event: WechatMiniprogram.TouchEvent) {
    const touches = event.touches
    if (touches.length >= 2) {
      // 双指：处理 pinch
      this._updatePinch(touches[0], touches[1])
    } else if (touches.length === 1 && !this._isPinching) {
      // 单指绘制（节流）
      const touch = touches[0]
      if (!touch) return
      this._pendingTouch = { x: touch.clientX, y: touch.clientY }
      if (this._rafHandle !== null) return
      this._rafHandle = setTimeout(() => {
        this._rafHandle = null
        const pending = this._pendingTouch
        if (!pending) return
        this._pendingTouch = null
        void this._processTouchMove(pending.x, pending.y)
      }, 16) as unknown as number
    }
  },

  onWorkspaceTouchEnd(event: WechatMiniprogram.TouchEvent) {
    const touches = event.touches
    if (touches.length === 0) {
      if (this._isPinching) {
        // 双指全部抬起：结束 pinch
        this._endPinch()
      } else {
        // 单指抬起：结束绘制
        void this._handleDrawTouchEnd(event)
      }
    } else if (touches.length === 1 && this._isPinching) {
      // 从双指变成单指：结束 pinch，等待用户再次单独触摸才绘制
      this._endPinch()
    }
  },

  // ─── Pinch 手势实现 ────────────────────────────────────────────────────────

  _pinchDist(t0: WechatMiniprogram.TouchDetail, t1: WechatMiniprogram.TouchDetail): number {
    const dx = t1.clientX - t0.clientX
    const dy = t1.clientY - t0.clientY
    return Math.sqrt(dx * dx + dy * dy)
  },

  _beginPinch(t0: WechatMiniprogram.TouchDetail, t1: WechatMiniprogram.TouchDetail) {
    this._isPinching = true
    this._pinchStartDist = this._pinchDist(t0, t1)
    this._pinchStartZoom = this.data.zoom
    this._pinchStartPanX = this.data.panX
    this._pinchStartPanY = this.data.panY
    this._pinchStartMidX = (t0.clientX + t1.clientX) / 2
    this._pinchStartMidY = (t0.clientY + t1.clientY) / 2
  },

  _updatePinch(t0: WechatMiniprogram.TouchDetail, t1: WechatMiniprogram.TouchDetail) {
    if (!this._isPinching) return
    const dist = this._pinchDist(t0, t1)
    if (this._pinchStartDist === 0) return

    // 计算新 zoom
    const rawZoom = this._pinchStartZoom * (dist / this._pinchStartDist)
    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, rawZoom))

    // 当前双指中点（屏幕坐标）
    const midX = (t0.clientX + t1.clientX) / 2
    const midY = (t0.clientY + t1.clientY) / 2

    // 以 pinch 开始时的双指中点为缩放中心，同时考虑中点移动带来的平移
    // 原理：start 中点对应画布上的某个点，缩放后该点仍应对应当前中点
    const zoomRatio = newZoom / this._pinchStartZoom
    const newPanX = midX - this._workspaceCenterX - (this._pinchStartMidX - this._workspaceCenterX - this._pinchStartPanX) * zoomRatio
    const newPanY = midY - this._workspaceCenterY - (this._pinchStartMidY - this._workspaceCenterY - this._pinchStartPanY) * zoomRatio

    // 应用 pan 边界
    const clampedPan = this._clampPan(newPanX, newPanY, newZoom)

    // 节流 setData（~16ms）
    const now = Date.now()
    if (now - this._lastPanSetDataTs < 16) return
    this._lastPanSetDataTs = now

    this._invalidateCanvasRect()
    this.setData({
      panX: clampedPan.x,
      panY: clampedPan.y,
      zoom: newZoom,
      zoomPercent: Math.round(newZoom * 100),
    })
  },

  _endPinch() {
    this._isPinching = false
    // pinch 结束后重绘（使用新 zoom）
    this._invalidateCanvasRect()
    this.drawPattern()
  },

  // ─── Pan 边界计算 ──────────────────────────────────────────────────────────

  /**
   * 计算合法的 pan 范围，确保图片四角都可以移动到 viewport 中心附近。
   * panX/panY 表示 canvas-stage 相对于 workspace 中心的偏移（CSS px）。
   */
  _clampPan(panX: number, panY: number, zoom: number): { x: number; y: number } {
    // 图片在当前 zoom 下的视觉尺寸
    const imageW = CANVAS_CSS_SIZE * zoom
    const imageH = CANVAS_CSS_SIZE * zoom

    // 允许图片中心偏移的最大值 = 图片半边 + workspace 半边（使角可达中心）
    // 通过 workspace 实际尺寸会更精确，但 workspace 尺寸初始化时已查询
    // 用 workspaceCenterX/Y 反推 workspace 尺寸（保守估计用固定值兜底）
    const wsW = this._workspaceCenterX > 0 ? this._workspaceCenterX * 2 : 300
    const wsH = this._workspaceCenterY > 0 ? this._workspaceCenterY * 2 : 300

    const maxPanX = imageW / 2 + wsW / 2
    const maxPanY = imageH / 2 + wsH / 2

    return {
      x: Math.min(maxPanX, Math.max(-maxPanX, panX)),
      y: Math.min(maxPanY, Math.max(-maxPanY, panY)),
    }
  },

  // ─── 单指绘制 touch 处理 ─────────────────────────────────────────────────

  async _handleDrawTouchStart(touch: WechatMiniprogram.TouchDetail) {
    const cell = await this.touchToGridCell(touch.clientX, touch.clientY)
    if (!cell) return

    const tool = this.data.activeTool

    if (tool === 'pencil' || tool === 'eraser') {
      this._beginStroke()
      this._applyPencilOrEraser(cell)
      void this.updateMagnifierAt(touch.clientX, touch.clientY, cell)
    } else if (tool === 'eyedropper') {
      void this.updateMagnifierAt(touch.clientX, touch.clientY, cell)
    }
    // fill 在 touchend 处理
  },

  async _processTouchMove(clientX: number, clientY: number) {
    const cell = await this.touchToGridCell(clientX, clientY)
    if (!cell) return
    const tool = this.data.activeTool

    if (tool === 'pencil' || tool === 'eraser') {
      this._applyPencilOrEraser(cell)
      void this.updateMagnifierAt(clientX, clientY, cell)
    } else if (tool === 'eyedropper') {
      void this.updateMagnifierAt(clientX, clientY, cell)
    }
  },

  async _handleDrawTouchEnd(event: WechatMiniprogram.TouchEvent) {
    const touch = event.changedTouches[0]
    this._clearRaf()
    this._pendingTouch = null

    const tool = this.data.activeTool

    if (tool === 'pencil' || tool === 'eraser') {
      this._commitStroke()
      this.hideMagnifier()
      return
    }

    if (tool === 'eyedropper') {
      this.hideMagnifier()
      if (!touch) return
      const cell = await this.touchToGridCell(touch.clientX, touch.clientY)
      if (!cell) return
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

    if (tool === 'fill') {
      if (!touch) return
      const cell = await this.touchToGridCell(touch.clientX, touch.clientY)
      if (!cell) return
      this._applyFill(cell)
    }
  },

  // ─── 工具操作实现 ─────────────────────────────────────────────────────────

  _beginStroke() {
    const draft = this.data.draft
    if (!draft) return
    this._stroke = {
      snapshot: draft.cells.map((c) => ({ ...c })),
      visited: new Set(),
      dirty: false,
    }
  },

  /** 取消当前 stroke（双指打断时调用） */
  _cancelStroke() {
    const stroke = this._stroke
    this._stroke = null
    if (!stroke?.dirty) return
    // 还原到 stroke 开始前的快照（避免误画）
    const draft = this.data.draft
    if (!draft) return
    stroke.snapshot.forEach((cell, i) => {
      draft.cells[i] = { ...cell }
    })
    this.drawPattern()
  },

  _applyPencilOrEraser(cell: GridCell) {
    const draft = this.data.draft
    const stroke = this._stroke
    if (!draft || !stroke) return

    if (stroke.visited.has(cell.index)) return
    stroke.visited.add(cell.index)

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

    draft.cells[cell.index] = nextCell
    stroke.dirty = true

    this._repaintCell(cell.row, cell.column, nextCell)
  },

  _repaintCell(row: number, column: number, cell: PatternCell) {
    const draft = this.data.draft
    const rect = this._canvasRect
    if (!draft || !rect) {
      this.drawPattern()
      return
    }

    wx.createSelectorQuery()
      .in(this)
      .select('#patternCanvas')
      .fields({ node: true, size: true })
      .exec((results) => {
        const result = results[0] as CanvasQueryResult | undefined
        if (!result?.node) return
        const canvas = result.node
        const ctx = canvas.getContext('2d')
        const zoom = this.data.zoom
        const cellWidth = (rect.width / draft.settings.width) * zoom
        const cellHeight = (rect.height / draft.settings.height) * zoom
        const originX = (rect.width - cellWidth * draft.settings.width) / 2
        const originY = (rect.height - cellHeight * draft.settings.height) / 2
        const px = originX + column * cellWidth
        const py = originY + row * cellHeight
        const cx = px + cellWidth / 2
        const cy = py + cellHeight / 2
        const radius = Math.min(cellWidth, cellHeight) * 0.44

        ctx.clearRect(px - 1, py - 1, cellWidth + 2, cellHeight + 2)
        ctx.fillStyle = '#f7f7f7'
        ctx.fillRect(px - 1, py - 1, cellWidth + 2, cellHeight + 2)

        if (cell.color !== 'transparent') {
          ctx.globalAlpha = 0.18
          ctx.fillStyle = '#000000'
          ctx.beginPath()
          ctx.arc(cx + cellWidth * 0.06, cy + cellHeight * 0.08, radius, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = 1
          ctx.fillStyle = cell.color
          ctx.beginPath()
          ctx.arc(cx, cy, radius, 0, Math.PI * 2)
          ctx.fill()
          if (radius >= 1.8) {
            ctx.globalAlpha = 0.34
            ctx.fillStyle = '#ffffff'
            ctx.beginPath()
            ctx.arc(cx - radius * 0.32, cy - radius * 0.34, radius * 0.22, 0, Math.PI * 2)
            ctx.fill()
          }
          ctx.globalAlpha = 1
        }
      })
  },

  _commitStroke() {
    const stroke = this._stroke
    this._stroke = null
    if (!stroke?.dirty) return
    const draft = this.data.draft
    if (!draft) return

    const updatedCells = draft.cells.map((c) => ({ ...c }))
    const undoStack = [...this.data.undoStack, stroke.snapshot].slice(-EDIT_HISTORY_LIMIT)
    this.applyEditedCells(updatedCells, undoStack, [])
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
    const zoom = Math.min(ZOOM_MAX, Number((this.data.zoom + ZOOM_STEP).toFixed(1)))
    this._invalidateCanvasRect()
    this.setData({ zoom, zoomPercent: Math.round(zoom * 100) }, () => this.drawPattern())
  },

  zoomOut() {
    const zoom = Math.max(ZOOM_MIN, Number((this.data.zoom - ZOOM_STEP).toFixed(1)))
    this._invalidateCanvasRect()
    this.setData({ zoom, zoomPercent: Math.round(zoom * 100) }, () => this.drawPattern())
  },

  /** 重置视图：回到 100%、画布居中 */
  resetView() {
    this._invalidateCanvasRect()
    this.setData(
      { zoom: ZOOM_DEFAULT, zoomPercent: 100, panX: 0, panY: 0 },
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

  // ─── RAF 工具 ────────────────────────────────────────────────────────────

  _clearRaf() {
    if (this._rafHandle !== null) {
      clearTimeout(this._rafHandle)
      this._rafHandle = null
    }
  },

  // ─── 保存 ─────────────────────────────────────────────────────────────────

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
})
