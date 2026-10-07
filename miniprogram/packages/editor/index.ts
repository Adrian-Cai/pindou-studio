/**
 * 编辑器页：图纸手绘编辑 + 画布手势 + 撤销重做 + 保存。
 *
 * 职责：承载 2d canvas 画布，处理单指平移/双指缩放手势与画笔/橡皮/吸管/填充等触摸操作，
 *       维护 undo/redo 栈，把编辑结果保存为本地或云端作品并跳转结果页；
 *       不负责图片生成（那是生成页）与图纸渲染像素计算（交给 pattern-editor-service）。
 * 调用方：生成页保存后 / AI 生成完成后 navigateTo 到此页（路由 /packages/editor/index）。
 * 关键点：手势与绘制共用一套 touch 回调；用 _canvasRenderVersion 版本号防止异步测量/绘制竞态
 *       （旧回调若版本对不上直接丢弃）；底部控制面板复用公共组件 editor-control-panel。
 *
 * setData 纪律：网格 cells 与撤销栈**绝不能**进 data。渲染层只需要尺寸/色数/计数这类小字段，
 *       cells 走的是 canvas；一旦把整张网格（上千个 {color,colorCode}）塞进 data，
 *       每次落笔都要往视图层序列化传一份（撤销栈还是它的 N 份快照），实测单笔 2MB，
 *       微信直接告警「setData 数据传输长度过长」。网格一律留在实例字段里。
 */
import {
  getPaletteColors,
  resolveGenerationMode,
  type GenerationMode,
  type PatternCell,
  type PatternDraft,
} from '../../models/pattern'
import { appStore } from '../../store/app-store'
import {
  cloudSummaryToWorkItem,
  hasCloudSession,
  saveNewCloudWork,
  updateCloudWork,
} from '../../services/work-service'
import { isNetworkError, queueWorkForSync } from '../../services/work-sync-service'
import { persistImage, prepareImageForContentSecurity, removePersistedWorkImage } from '../../services/image-service'
import { aiTaskManager } from '../../services/ai-generation-manager'
import {
  calculateFittedImageSize,
  clampViewTranslation,
  drawPatternViewport,
  EDIT_HISTORY_LIMIT,
  applyPatch,
  fillConnectedCells,
  sameCell,
  scaleAroundViewportPoint,
  screenPointToGridCell,
  toDraftView,
  transformFromPinch,
  type CanvasRect,
  type DraftView,
  type EditPatch,
  type FittedImageSize,
  type GridCell,
  type PatternCanvasContext,
  type ViewTransform,
} from './services/pattern-editor-service'

/** 跳到 AI 任务详情页：带上 taskId 才能定位到具体那条任务。 */
function aiTaskDetailUrl(taskId?: string): string {
  return taskId
    ? `/packages/ai-generation/index?taskId=${encodeURIComponent(taskId)}&from=home`
    : '/packages/ai-generation/index?from=home'
}

interface PatternCanvas {
  width: number
  height: number
  getContext(type: '2d'): PatternCanvasContext
}

/** Toast 状态 */
interface ToastState {
  visible: boolean
  message: string
}

/** 缩放范围：1x ~ 6x，按钮每步按 1.25 倍变化。 */
const SCALE_MIN = 1
const SCALE_MAX = 6
const SCALE_FACTOR = 1.25
const SCALE_DEFAULT = 1
const PAN_THRESHOLD = 8

const nextScale = (scale: number, direction: 1 | -1): number => Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale * (direction > 0 ? SCALE_FACTOR : 1 / SCALE_FACTOR)))

Page({
  data: {
    /** 渲染用元信息，不含 cells（见文件头的 setData 纪律） */
    draft: null as DraftView | null,
    generationMode: 'standard' as GenerationMode,
    scalePercent: 100,
    beadCount: 0,
    paletteColors: [] as string[],
    selectedColor: '',
    selectedColorCode: '',
    canvasReady: false,
    activeTool: 'pencil',
    saving: false,
    canUndo: false,
    canRedo: false,
    toast: {
      visible: false,
      message: '',
    } as ToastState,
  },

  /** 编辑中的完整草稿（含 cells）：网格的唯一权威来源，不进 data。 */
  _draft: null as PatternDraft | null,
  /** 当前视图变换（缩放/平移）：只喂给 canvas 绘制与坐标换算，不进 data。 */
  _transform: { scale: SCALE_DEFAULT, translateX: 0, translateY: 0 } as ViewTransform,
  _undoStack: [] as EditPatch[],
  _redoStack: [] as EditPatch[],
  _workspaceRect: null as CanvasRect | null,
  _viewportRect: null as CanvasRect | null,
  _boardInCanvas: null as CanvasRect | null,
  _fittedImage: null as FittedImageSize | null,
  _patternCanvasNode: null as PatternCanvas | null,
  _singleTouchActive: false,
  _singleTouchMoved: false,
  _singleTouchStartX: 0,
  _singleTouchStartY: 0,
  _singleTouchStartTransform: { scale: SCALE_DEFAULT, translateX: 0, translateY: 0 } as ViewTransform,
  _blockSingleTouchUntilRelease: false,
  _toastTimer: null as ReturnType<typeof setTimeout> | null,
  _canvasRenderVersion: 0,

  _isPinching: false,
  /** pinch 开始时两指距离（像素），用于求缩放比 */
  _pinchStartDist: 0,
  /** pinch 开始时视图变换 */
  _pinchStartTransform: { scale: SCALE_DEFAULT, translateX: 0, translateY: 0 } as ViewTransform,
  /** pinch 开始时双指中点（viewport 局部坐标） */
  _pinchStartMidX: 0,
  _pinchStartMidY: 0,

  onLoad(options?: Record<string, string | undefined>) {
    // 预览模式：跳到对应任务的详情页查看进度
    const previewRequested = options?.preview === 'generating' || options?.preview === 'ai'
    if (previewRequested) {
      wx.redirectTo({ url: aiTaskDetailUrl(options?.taskId) })
      return
    }

    let draft = appStore.getSnapshot().currentDraft
    // AI 任务尚未完成的占位草稿：回到任务详情页，而不是进编辑器对着空网格发呆
    if (draft && aiTaskManager.getTaskView(draft.id)?.isActive) {
      wx.redirectTo({ url: aiTaskDetailUrl(draft.id) })
      return
    }
    if (!draft) {
      wx.showToast({ title: '请先选择图片', icon: 'none' })
      setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 500)
      return
    }

    const generationMode = resolveGenerationMode(draft)
    if (draft && draft.generationMode !== generationMode) {
      draft = { ...draft, generationMode }
    }

    const paletteColors = getPaletteColors(draft.cells)
    const firstColor = paletteColors[0] ?? ''
    const firstColorCode = firstColor
      ? (draft.cells.find((c) => c.color === firstColor)?.colorCode ?? '')
      : ''
    // 网格在编辑中会被原地替换格子，这里先浅拷一份数组，避免直接改到 store 里那份对象
    this._draft = { ...draft, cells: draft.cells.slice() }
    this._transform = { scale: SCALE_DEFAULT, translateX: 0, translateY: 0 }
    this._undoStack = []
    this._redoStack = []
    this.setData({
      draft: toDraftView(draft),
      generationMode,
      paletteColors,
      selectedColor: firstColor,
      selectedColorCode: firstColorCode,
      beadCount: draft.cells.filter((cell) => cell.color !== 'transparent').length,
    })
  },

  onReady() {
    this.measureViewport(true)
  },

  onResize() {
    this.measureViewport(true)
  },

  onUnload() {
    this._clearToastTimer()
  },

  selectNewImage() {
    void appStore.setCurrentDraft(null)
    wx.switchTab({ url: '/pages/home/index' })
  },

  stopWorkspaceTouch() {
    this._singleTouchActive = false
  },

  selectTool(event: WechatMiniprogram.CustomEvent<{ tool: string }>) {
    if (!this.data.canvasReady) return
    const tool = event.detail.tool
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

  selectPaletteColor(event: WechatMiniprogram.CustomEvent<{ color: string }>) {
    if (!this.data.canvasReady) return
    const color = event.detail.color
    const cells = this._draft?.cells ?? []
    const colorCode = cells.find((c) => c.color === color)?.colorCode ?? ''
    this.setData({ selectedColor: color, selectedColorCode: colorCode })
  },

  measureViewport(resetView: boolean) {
    const draft = this._draft
    if (!draft) return
    // 递增版本号：本次测量开始前的旧异步回调若版本对不上则丢弃，避免竞态覆盖
    const renderVersion = ++this._canvasRenderVersion
    this._workspaceRect = null
    this._viewportRect = null
    this._boardInCanvas = null
    this._fittedImage = null
    this._patternCanvasNode = null
    this.setData({ canvasReady: false })
    wx.createSelectorQuery()
      .in(this)
      .select('.workspace')
      .fields({ rect: true, size: true })
      .select('.workspace__board')
      .fields({ rect: true, size: true })
      .exec((results) => {
        // 期间若发生重测，本次结果作废
        if (renderVersion !== this._canvasRenderVersion) return
        const workspace = results[0] as CanvasRect | undefined
        const board = results[1] as CanvasRect | undefined
        if (!workspace?.width || !workspace.height || !board?.width || !board.height) return
        this._workspaceRect = workspace
        this._viewportRect = board
        this._boardInCanvas = {
          left: board.left - workspace.left,
          top: board.top - workspace.top,
          width: board.width,
          height: board.height,
        }
        const fittedImage = calculateFittedImageSize(
          board.width,
          board.height,
          draft.settings.width,
          draft.settings.height,
        )
        this._fittedImage = fittedImage
        if (resetView) {
          this._transform = { scale: SCALE_DEFAULT, translateX: 0, translateY: 0 }
          this.setData({ scalePercent: 100 }, () => this.drawPattern(renderVersion))
          return
        }
        this.drawPattern(renderVersion)
      })
  },

  drawPattern(renderVersion?: number) {
    const activeRenderVersion = renderVersion ?? this._canvasRenderVersion
    const draft = this._draft
    const workspace = this._workspaceRect
    const viewport = this._viewportRect
    const board = this._boardInCanvas
    const image = this._fittedImage
    if (!draft || !workspace || !viewport || !board || !image || activeRenderVersion !== this._canvasRenderVersion) return

    const markCanvasReady = () => {
      if (activeRenderVersion !== this._canvasRenderVersion || this.data.canvasReady) return
      this.setData({ canvasReady: true })
    }

    const render = (canvas: PatternCanvas) => {
      drawPatternViewport(
        canvas.getContext('2d'),
        workspace.width,
        workspace.height,
        board,
        image,
        this._transform,
        draft,
      )
    }
    if (this._patternCanvasNode) {
      render(this._patternCanvasNode)
      markCanvasReady()
      return
    }

    wx.createSelectorQuery()
      .in(this)
      .select('#patternCanvas')
      .fields({ node: true, size: true })
      .exec((results) => {
        if (activeRenderVersion !== this._canvasRenderVersion) return
        const result = results[0] as { node: PatternCanvas; width: number; height: number } | undefined
        if (!result?.node || !result.width || !result.height) return

        const canvas = result.node
        const context = canvas.getContext('2d')
        // 按设备像素比放大 canvas 物理分辨率，再 scale 让绘制用 CSS px 坐标，保证高清不糊
        const pixelRatio = wx.getWindowInfo().pixelRatio || 1
        canvas.width = Math.round(workspace.width * pixelRatio)
        canvas.height = Math.round(workspace.height * pixelRatio)
        context.scale(pixelRatio, pixelRatio)
        this._patternCanvasNode = canvas
        render(canvas)
        markCanvasReady()
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
        .select('.workspace__board')
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
    const draft = this._draft
    const image = this._fittedImage
    if (!draft || !image) return null
    const viewportRect = await this.ensureViewportRect()
    return screenPointToGridCell(x, y, viewportRect, image, this._transform, draft)
  },

  onWorkspaceTouchStart(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.canvasReady) return
    const touches = event.touches
    // 双指直接进 pinch（缩放）；单指且非 pinch 中才记为一次绘制触摸
    if (touches.length >= 2) {
      this._beginPinch(touches[0], touches[1])
      return
    }
    if (touches.length === 1 && !this._isPinching && !this._blockSingleTouchUntilRelease) {
      this._singleTouchActive = true
      this._singleTouchMoved = false
      this._singleTouchStartX = touches[0].clientX
      this._singleTouchStartY = touches[0].clientY
      this._singleTouchStartTransform = { ...this._transform }
    }
  },

  onWorkspaceTouchMove(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.canvasReady) return
    const touches = event.touches
    // 移动中只有双指参与缩放，单指平移不在此处理（由 fill/pencil 用端点落格）
    if (touches.length >= 2) {
      if (!this._isPinching) this._beginPinch(touches[0], touches[1])
      this._updatePinch(touches[0], touches[1])
      return
    }
    if (
      this._blockSingleTouchUntilRelease
      || (!this._singleTouchActive && !this._singleTouchMoved)
      || touches.length !== 1
    ) return
    const touch = touches[0]
    const dx = touch.clientX - this._singleTouchStartX
    const dy = touch.clientY - this._singleTouchStartY
    if (!this._singleTouchMoved && Math.hypot(dx, dy) > PAN_THRESHOLD) {
      this._singleTouchMoved = true
      this._singleTouchActive = false
    }
    if (!this._singleTouchMoved || this._transform.scale <= SCALE_MIN) return
    const translation = this._clampTranslation(
      this._singleTouchStartTransform.translateX + dx,
      this._singleTouchStartTransform.translateY + dy,
      this._singleTouchStartTransform.scale,
    )
    this._transform = {
      ...this._singleTouchStartTransform,
      translateX: translation.x,
      translateY: translation.y,
    }
    this.drawPattern()
  },

  onWorkspaceTouchEnd(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.canvasReady) return
    const touches = event.touches
    if (this._isPinching) {
      // 还有两指则继续；松开到 <2 指结束 pinch，并屏蔽剩余手指直到完全抬起，避免误触
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
    // 单指抬起：若本次是有效的绘制触摸，按落点执行工具
    const touch = event.changedTouches[0]
    const shouldExecute = this._singleTouchActive && !this._singleTouchMoved && Boolean(touch)
    this._singleTouchActive = false
    this._singleTouchMoved = false
    if (shouldExecute && touch) void this.finishSingleTouch(touch.clientX, touch.clientY)
  },

  onWorkspaceTouchCancel() {
    if (!this.data.canvasReady) return
    this._singleTouchActive = false
    this._singleTouchMoved = false
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
    this._pinchStartTransform = { ...this._transform }
    this._pinchStartMidX = (t0.clientX + t1.clientX) / 2 - viewport.left
    this._pinchStartMidY = (t0.clientY + t1.clientY) / 2 - viewport.top
  },

  _updatePinch(t0: WechatMiniprogram.TouchDetail, t1: WechatMiniprogram.TouchDetail) {
    if (!this._isPinching) return
    const viewport = this._viewportRect
    const image = this._fittedImage
    if (!viewport || !image) return
    const midX = (t0.clientX + t1.clientX) / 2 - viewport.left
    const midY = (t0.clientY + t1.clientY) / 2 - viewport.top
    this._transform = transformFromPinch(
      this._pinchStartTransform,
      this._pinchStartDist,
      this._pinchDist(t0, t1),
      this._pinchStartMidX,
      this._pinchStartMidY,
      midX,
      midY,
      viewport,
      SCALE_MIN,
      SCALE_MAX,
      image,
    )
    // 缩放/平移只影响 canvas，不进 data；只在整数百分比真的变了才同步一次（pinch 每帧都发会白烧渲染）
    this.drawPattern()
    this._syncScalePercent(this._transform.scale)
  },

  /** 缩放百分比变化时才推给渲染层（用于面板显示与缩放按钮禁用态）。 */
  _syncScalePercent(scale: number) {
    const scalePercent = Math.round(scale * 100)
    if (scalePercent === this.data.scalePercent) return
    this.setData({ scalePercent })
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

  /**
   * 单指落点成笔：把手势坐标换算成格子后执行当前工具。
   *
   * 这里必须做 await 后的复检 —— `touchToGridCell` 内部要先 await 一次异步测量，
   * 期间一旦换了纸（比如重进页面换成另一份草稿），落点换算是按旧图纸尺寸算的，
   * `cell.index` 会对着一格子完全不相干的位置，笔就画错了地方且无从察觉。
   */
  async finishSingleTouch(clientX: number, clientY: number) {
    if (!this.data.canvasReady) return
    const draft = this._draft
    if (!draft) return
    // 只锁参与坐标换算的量：版本号（viewport 几何）+ 网格尺寸。
    // 不比 draft 引用 —— 落笔只改 cells 数组内部的元素，draft 引用不变，比引用没有意义。
    const renderVersion = this._canvasRenderVersion
    const gridKey = `${draft.id}:${draft.settings.width}x${draft.settings.height}`
    const cell = await this.touchToGridCell(clientX, clientY).catch(() => null)
    if (!this.data.canvasReady || this._isPinching || this._blockSingleTouchUntilRelease) return
    if (this._canvasRenderVersion !== renderVersion) return
    const current = this._draft
    if (!current || `${current.id}:${current.settings.width}x${current.settings.height}` !== gridKey) return
    if (cell) this.executeToolAt(cell)
  },

  executeToolAt(cell: GridCell) {
    const tool = this.data.activeTool
    if (tool === 'pencil' || tool === 'eraser') {
      this._applyPencilOrEraserTap(cell)
      return
    }
    if (tool === 'eyedropper') {
      const draft = this._draft
      if (!draft) return
      const pickedCell = draft.cells[cell.index]
      if (!pickedCell || pickedCell.color === 'transparent') return
      // 吸管：把落点颜色设为当前画笔色并自动切回 pencil 方便继续画
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
    const draft = this._draft
    if (!draft) return
    // 网格原地替换单个格子：不再整张深拷贝，落笔从 O(N) 次对象分配降为 O(1)
    const cells = draft.cells
    const currentCell = cells[cell.index]
    if (!currentCell) return
    const tool = this.data.activeTool
    let nextCell: PatternCell
    if (tool === 'eraser') {
      // 橡皮：把该格改回透明；已是透明则不动（避免无谓的撤销栈）
      if (currentCell.color === 'transparent') return
      nextCell = { color: 'transparent', colorCode: '' }
    } else {
      const replacement = cells.find((c) => c.color === this.data.selectedColor)
      if (!replacement || sameCell(currentCell, replacement)) return
      nextCell = replacement
    }
    cells[cell.index] = nextCell
    this.commitEdit({ indexes: [cell.index], before: [currentCell], after: [nextCell] })
  },

  _applyFill(cell: GridCell) {
    const draft = this._draft
    if (!draft) return
    const cells = draft.cells
    const currentCell = cells[cell.index]
    if (!currentCell) return
    const replacement = cells.find((c) => c.color === this.data.selectedColor)
    if (!replacement || sameCell(currentCell, replacement)) return

    // 连通域填充：把与落点颜色相同且相连的区域整片替换成当前色；返回被改的格子与其旧值
    const replaced = fillConnectedCells(
      cells,
      cell.index,
      draft.settings.width,
      draft.settings.height,
      currentCell,
      replacement,
    )
    if (replaced.length === 0) return
    this.commitEdit({
      indexes: replaced.map((item) => item.index),
      before: replaced.map((item) => item.before),
      after: replaced.map(() => replacement),
    })
  },

  // ─── 撤销 / 重做 ─────────────────────────────────────────────────────────
  // 栈元素是「增量 patch」而不是整张网格快照：20 步快照 × N 格既是内存黑洞，
  // 也是当初 setData 一次传 2MB 的元凶（快照曾整份塞在 data 里）。

  commitEdit(patch: EditPatch) {
    if (!this._draft) return
    // 提交一次编辑：patch 压入 undo 栈（限长），清空 redo 栈
    this._undoStack = [...this._undoStack, patch].slice(-EDIT_HISTORY_LIMIT)
    this._redoStack = []
    this.syncEditToView()
  },

  undoEdit() {
    const draft = this._draft
    const patch = this._undoStack[this._undoStack.length - 1]
    if (!draft || !patch) return
    // 撤销：把 patch 记录的旧值写回，patch 本身转压 redo 栈
    applyPatch(draft.cells, patch, 'before')
    this._undoStack = this._undoStack.slice(0, -1)
    this._redoStack = [...this._redoStack, patch].slice(-EDIT_HISTORY_LIMIT)
    this.syncEditToView()
  },

  redoEdit() {
    const draft = this._draft
    const patch = this._redoStack[this._redoStack.length - 1]
    if (!draft || !patch) return
    // 重做：把 patch 记录的新值写回，patch 转压 undo 栈
    applyPatch(draft.cells, patch, 'after')
    this._undoStack = [...this._undoStack, patch].slice(-EDIT_HISTORY_LIMIT)
    this._redoStack = this._redoStack.slice(0, -1)
    this.syncEditToView()
  },

  /**
   * 网格变更后的统一收尾：同步 store，只把渲染真正需要的极小字段推给视图层，再重绘。
   *
   * 这里绝不能把 cells 或撤销栈塞进 setData —— 网格上千格、撤销栈曾是它的 N 份快照，
   * 一笔画下去就是 MB 级跨线程传输，微信会直接告警「数据传输长度过长」。
   */
  syncEditToView() {
    const draft = this._draft
    if (!draft) return
    appStore.setCurrentDraft(draft)
    this.setData({
      beadCount: draft.cells.filter((cell) => cell.color !== 'transparent').length,
      canUndo: this._undoStack.length > 0,
      canRedo: this._redoStack.length > 0,
    })
    this.drawPattern()
  },

  // ─── 缩放（按钮） ─────────────────────────────────────────────────────────

  zoomIn() {
    if (!this.data.canvasReady) return
    this._setScaleAtViewportCenter(nextScale(this._transform.scale, 1))
  },

  zoomOut() {
    if (!this.data.canvasReady) return
    this._setScaleAtViewportCenter(nextScale(this._transform.scale, -1))
  },

  _setScaleAtViewportCenter(nextScale: number) {
    const viewport = this._viewportRect
    if (!viewport) return
    const anchored = scaleAroundViewportPoint(
      this._transform,
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
    this._transform = { scale: nextScale, translateX: translation.x, translateY: translation.y }
    this.drawPattern()
    this._syncScalePercent(nextScale)
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
    if (this.data.saving || !this.data.canvasReady) return
    const currentDraft = this._draft
    if (!currentDraft) return
    this.setData({ saving: true })
    wx.showLoading({ title: '正在保存', mask: true })
    try {
      const workImageDirectory = `${wx.env.USER_DATA_PATH}/pindou-work-images`
      const sourceImagePath = currentDraft.sourceImagePath
        ? await persistImage(currentDraft.sourceImagePath, workImageDirectory)
        : ''
      if (sourceImagePath && !sourceImagePath.startsWith(`${workImageDirectory}/`)) {
        throw new Error('原图保存失败，请重试')
      }
      const draft = { ...currentDraft, sourceImagePath }
      const state = appStore.getSnapshot()
      const existing = state.works.find((item) => item.id === draft.id)
      const updatingCloudWork = Boolean(existing?.syncStatus === 'synced' || existing?.isCloud)
      const coverPath = sourceImagePath || existing?.coverPath || ''
      if (!coverPath) throw new Error('作品原图缺失，无法保存')
      // 本地作品记录：先按草稿 id 找是否已存在（决定后续是更新还是新建云端作品）
      const localWork = {
          id: draft.id,
          title: existing?.title ?? '未命名作品',
          coverPath,
          generationMode: draft.generationMode,
          updatedAt: Date.now(),
          createdAt: existing?.createdAt ?? draft.createdAt,
          beadCount: this.data.beadCount,
          colorCount: getPaletteColors(draft.cells).length,
          width: draft.settings.width,
          height: draft.settings.height,
          status: 'completed' as const,
          isCloud: false,
      }
      if (!hasCloudSession()) {
        // 未登录：仅存本机，syncStatus 标记 guest
        await appStore.saveLocalDraft(draft)
        await appStore.saveWork({ ...localWork, syncStatus: 'guest' })
        wx.showToast({ title: '已保存到本机', icon: 'success' })
      } else {
        try {
          const uploadPath = updatingCloudWork && !sourceImagePath
            ? undefined
            : await prepareImageForContentSecurity(coverPath)
          // 已同步或云端的作品走更新，否则按新作品保存
          const summary = updatingCloudWork && existing
            ? await updateCloudWork(existing.id, draft, uploadPath, existing.title)
            : await saveNewCloudWork(draft, uploadPath ?? '', existing?.title ?? '未命名作品')
          const savedDraft = { ...draft, id: summary.id, sourceImagePath: '' }
          if (existing && existing.id !== summary.id) await appStore.deleteWork(existing.id)
          await appStore.removeLocalDraft(draft.id)
          await appStore.saveWork(cloudSummaryToWorkItem(summary))
          await appStore.setCurrentDraft(savedDraft)
          if (sourceImagePath && !appStore.getSnapshot().works.some((work) => work.coverPath === sourceImagePath)) {
            removePersistedWorkImage(sourceImagePath)
          }
          wx.showToast({ title: '已保存到云端', icon: 'success' })
        } catch (error) {
          // 云端失败：按网络错误与否标记为 pending（联网自动同步）或 failed
          const pending = isNetworkError(error)
          await queueWorkForSync({
            ...localWork,
            pendingCloudUpdate: updatingCloudWork,
            syncStatus: pending ? 'pending' : 'failed',
            syncError: error instanceof Error ? error.message : '云端保存失败，请稍后重试',
          }, draft)
          wx.showToast({
            title: pending ? '已保存到本机，联网后自动同步' : '已保存到本机，云端保存失败',
            icon: 'none',
          })
        }
      }
      wx.navigateTo({ url: '/packages/result/index' })
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
