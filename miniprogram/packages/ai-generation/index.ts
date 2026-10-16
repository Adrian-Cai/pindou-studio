/**
 * AI 任务详情页（分包 packages/ai-generation）：展示某一条 AI 生成任务的状态并提供操作。
 *
 * 职责：通过 `?taskId=` 绑定具体任务，把 AiTaskView 映射成页面 UI。
 *       整个 AI 生成过程只使用这一个页面：排队 / 生成中 / 失败 / 完成
 *       都在同一页面框架内原地切换中间主内容卡片，不设独立的失败页或成功页。
 *       生成中与失败态下方常驻禁用态编辑面板（100% 缩放、尺寸/颜色/颗数、
 *       工具栏、色板），成功后仍留在当前页，展示结果并启用同一面板。
 * 调用方：作品页点 pending/failed 卡片（`?taskId=&from=projects`）、
 *        首页创建 AI 任务后进入（`?taskId=&from=home`）。
 * 关键点：页面只订阅不驱动——onHide/onUnload 仅退订，任务照常在后台跑；
 *        `from` 只影响底部 Tab 高亮与返回意图，三种任务状态都在本页原地切换。
 */
import { aiTaskManager, type AiTaskView } from '../../services/ai-generation-manager'
import type { AiTaskStatus } from '../../services/ai-task-store'
import { getPaletteColors, type PatternDraft, type WorkItem } from '../../models/pattern'
import { appStore } from '../../store/app-store'
import type { CoordinateTick, PatternCanvasContext } from '../editor/services/pattern-renderer'
import { cloudSummaryToWorkItem, hasCloudSession, saveNewCloudWork, updateCloudWork } from '../../services/work-service'
import { isNetworkError, queueWorkForSync } from '../../services/work-sync-service'

/**
 * pattern-renderer 的单一来源在 editor 分包（主包不留未使用的 JS），跨分包经「分包异步化」按需加载。
 * 基础库 ≥ 2.17.3 才有 require.async；本页已在用 wx.getWindowInfo（≥ 2.20.1），无新增兼容门槛。
 * 加载失败（含首次拉取 editor 分包失败）由调用方 catch 后走 patternRenderError 兜底。
 */
type PatternRendererModule = typeof import('../editor/services/pattern-renderer')
let patternRendererPromise: Promise<PatternRendererModule> | null = null

function loadPatternRenderer(): Promise<PatternRendererModule> {
  if (!patternRendererPromise) {
    patternRendererPromise = require.async('../editor/services/pattern-renderer.js') as Promise<PatternRendererModule>
  }
  return patternRendererPromise
}

type TaskFrom = 'home' | 'projects'

interface PatternPreviewQueryResult {
  left: number
  top: number
  width: number
  height: number
}

interface PanGestureStart {
  clientX: number
  clientY: number
  panX: number
  panY: number
}

interface PinchGestureStart {
  distance: number
  scale: number
  panX: number
  panY: number
  midX: number
  midY: number
}

const MIN_SCALE_PERCENT = 100
const MAX_SCALE_PERCENT = 600
const SCALE_FACTOR = 1.25

function clampPanOffset(
  offset: number,
  viewportSize: number,
  scalePercent: number,
  contentExtent: number,
  cellCount: number,
): number {
  const scale = scalePercent / 100
  const contentSize = viewportSize * contentExtent
  const maxOffset = scale <= 1 || cellCount <= 0
    ? 0
    : Math.max(0, (contentSize - contentSize / cellCount) * scale / 2)
  return Math.max(-maxOffset, Math.min(maxOffset, offset))
}

function getContentExtent(width: number, height: number) {
  return { x: Math.min(width, height) / width, y: Math.min(width, height) / height }
}

function nextScalePercent(current: number, direction: 1 | -1): number {
  return Math.min(MAX_SCALE_PERCENT, Math.max(MIN_SCALE_PERCENT, Math.round(current * (direction > 0 ? SCALE_FACTOR : 1 / SCALE_FACTOR))))
}

function pinchDistance(t0: WechatMiniprogram.TouchDetail, t1: WechatMiniprogram.TouchDetail): number {
  return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
}

const GENERATING_STATUSES: ReadonlySet<AiTaskStatus> = new Set<AiTaskStatus>([
  'uploading',
  'submitting',
  'queued',
  'processing',
  'downloading',
  'converting',
])

const GENERATION_TIPS = [
  '正在为你优化图片细节',
  '生成完成后即可开始编辑',
]

Page({
  data: {
    selectedTab: 0,
    isQueued: false,
    isGenerating: false,
    isSucceeded: false,
    isFailed: false,
    progress: 0,
    queuePosition: 0,
    stateTitle: '',
    stateDescription: '',
    tipTexts: GENERATION_TIPS,
    /** 成功态在当前页面直接展示结果，编辑面板随草稿就绪切换为可用。 */
    draft: null as PatternDraft | null,
    editorReady: false,
    patternPreviewPath: '',
    patternRenderError: false,
    rulerColumns: [] as CoordinateTick[],
    rulerRows: [] as CoordinateTick[],
    activeTool: 'pencil',
    scalePercent: 100,
    panX: 0,
    panY: 0,
    canZoomOut: false,
    canZoomIn: true,
    paletteColors: [] as string[],
    selectedColor: '',
    saving: false,
    /** 生成中与失败态底部面板预填的图案参数（取自任务设置） */
    panelWidth: 0,
    panelHeight: 0,
    panelColorLimit: 0,
    panelBeadCount: 0,
  },

  _taskId: '',
  _from: 'home' as TaskFrom,
  _unsubscribe: null as (() => void) | null,
  _visible: false,
  _previewRenderId: 0,
  _boardWidth: 0,
  _boardHeight: 0,
  _boardRect: null as PatternPreviewQueryResult | null,
  _panGesture: null as PanGestureStart | null,
  _pinchGesture: null as PinchGestureStart | null,
  _blockGestureUntilRelease: false,

  onLoad(query?: Record<string, string | undefined>) {
    const from: TaskFrom = query?.from === 'projects' ? 'projects' : 'home'
    // 没带 taskId 时回退到最近一个任务；都没有就直接回首页，不再出现「无任务却停在生成页」
    const taskId = aiTaskManager.resolveTaskId(query?.taskId)
    if (!taskId) {
      wx.showToast({ title: '没有进行中的 AI 任务', icon: 'none' })
      wx.switchTab({ url: '/pages/home/index' })
      return
    }
    this._taskId = taskId
    this._from = from
    this.setData({
      selectedTab: from === 'projects' ? 1 : 0,
    })
    this.subscribe()
  },

  onShow() {
    this._visible = true
    if (!this._taskId) return
    if (!this._unsubscribe) this.subscribe()
    // 后台回来状态可能已变，重新拉一次快照
    this.syncTask()
  },

  onHide() {
    this._visible = false
    this._previewRenderId += 1
    this._panGesture = null
    this._pinchGesture = null
    this._blockGestureUntilRelease = false
    this.unsubscribe()
  },

  onUnload() {
    this._visible = false
    this._previewRenderId += 1
    this._panGesture = null
    this._pinchGesture = null
    this._blockGestureUntilRelease = false
    this.unsubscribe()
  },

  onResize() {
    if (this.data.isSucceeded && this.data.draft) this.renderPatternPreview()
  },

  subscribe() {
    const taskId = this._taskId
    if (!taskId) return
    this.unsubscribe()
    this._unsubscribe = aiTaskManager.subscribeTask(taskId, () => this.syncTask())
  },

  unsubscribe() {
    this._unsubscribe?.()
    this._unsubscribe = null
  },

  syncTask() {
    const taskId = this._taskId
    if (!taskId) return
    const view = aiTaskManager.getTaskView(taskId)
    if (!view) {
      // 任务记录已消失（用户在别处取消了）：别卡在详情页
      this.unsubscribe()
      wx.showToast({ title: '这个任务已不存在', icon: 'none' })
      this.goBack()
      return
    }
    this.applyView(view)
    if (view.isSucceeded) void this.handleSucceeded()
  },

  applyView(view: AiTaskView) {
    const isGenerating = GENERATING_STATUSES.has(view.status)
    const isFailed = view.isFailed
    const isSucceeded = view.isSucceeded
    const isQueued = !isGenerating && !isFailed && !isSucceeded
    if (!isSucceeded) this._previewRenderId += 1
    this.setData({
      isQueued,
      isGenerating,
      isSucceeded,
      isFailed,
      progress: view.progress,
      queuePosition: view.queuePosition,
      stateTitle: view.stateTitle,
      stateDescription: view.stateDescription,
      tipTexts: GENERATION_TIPS,
      panelWidth: view.width,
      panelHeight: view.height,
      panelColorLimit: view.colorLimit,
      // 图案尚未生成，颗粒数按满格（宽×高）预估展示
      panelBeadCount: view.width * view.height,
      editorReady: false,
      ...(isSucceeded ? {} : {
        draft: null,
        paletteColors: [],
        selectedColor: '',
        patternPreviewPath: '',
        patternRenderError: false,
        panX: 0,
        panY: 0,
        scalePercent: MIN_SCALE_PERCENT,
        canZoomOut: false,
        canZoomIn: true,
      }),
    })
  },

  /** 成功后留在当前页面，把状态卡片切换成结果预览和可用编辑面板。 */
  async handleSucceeded() {
    if (!this._visible) return
    const draft = appStore.getLocalDraft(this._taskId)
    if (!draft) return
    const paletteColors = getPaletteColors(draft.cells)
    const selectedColor = paletteColors.includes(this.data.selectedColor)
      ? this.data.selectedColor
      : (paletteColors[0] ?? '')
    const draftChanged = this.data.draft?.id !== draft.id
    this._previewRenderId += 1
    this.setData({
      draft,
      editorReady: true,
      patternPreviewPath: '',
      patternRenderError: false,
      panX: draftChanged ? 0 : this.data.panX,
      panY: draftChanged ? 0 : this.data.panY,
      scalePercent: draftChanged ? MIN_SCALE_PERCENT : this.data.scalePercent,
      canZoomOut: !draftChanged && this.data.scalePercent > MIN_SCALE_PERCENT,
      canZoomIn: draftChanged || this.data.scalePercent < MAX_SCALE_PERCENT,
      paletteColors,
      selectedColor,
    }, () => this.renderPatternPreview())
    if (draftChanged && appStore.getSnapshot().currentDraft?.id !== draft.id) {
      try {
        await appStore.setCurrentDraft(draft)
      } catch (error) {
        console.error('设置当前草稿失败', error)
      }
    }
  },

  cancelTask() {
    const taskId = this._taskId
    if (!taskId) return
    wx.showModal({
      title: '取消生成？',
      content: '取消后这条任务会从作品列表移除，需要重新选图生成。',
      cancelText: '继续生成',
      confirmText: '取消生成',
      confirmColor: '#e5484d',
      success: ({ confirm }) => {
        if (!confirm) return
        void aiTaskManager.cancelTask(taskId).then(() => {
          this.unsubscribe()
          this.goBack()
        })
      },
    })
  },

  retry() {
    const taskId = this._taskId
    if (!taskId) return
    void aiTaskManager.retryTask(taskId).then(() => this.syncTask())
  },

  selectTool(event: WechatMiniprogram.CustomEvent<{ tool: string }>) {
    const tool = event.detail.tool
    if (tool === 'undo' || tool === 'redo') return
    this.setData({ activeTool: tool })
  },

  selectPaletteColor(event: WechatMiniprogram.CustomEvent<{ color: string }>) {
    this.setData({ selectedColor: event.detail.color })
  },

  zoomIn() {
    this.zoomTo(nextScalePercent(this.data.scalePercent, 1))
  },

  zoomOut() {
    this.zoomTo(nextScalePercent(this.data.scalePercent, -1))
  },

  zoomTo(next: number) {
    const draft = this.data.draft
    if (!draft || !this._boardWidth || !this._boardHeight) return
    const oldScale = this.data.scalePercent / 100
    const newScale = next / 100
    const extent = getContentExtent(draft.settings.width, draft.settings.height)
    this.setData({
      scalePercent: next,
      panX: clampPanOffset(this.data.panX * newScale / oldScale, this._boardWidth, next, extent.x, draft.settings.width),
      panY: clampPanOffset(this.data.panY * newScale / oldScale, this._boardHeight, next, extent.y, draft.settings.height),
      canZoomIn: next < MAX_SCALE_PERCENT,
      canZoomOut: next > MIN_SCALE_PERCENT,
    })
  },

  previewTouchStart(event: WechatMiniprogram.TouchEvent) {
    if (event.touches.length >= 2) {
      this.beginPinch(event.touches[0], event.touches[1])
      return
    }
    if (this._blockGestureUntilRelease || this.data.scalePercent <= MIN_SCALE_PERCENT || event.touches.length !== 1) {
      this._panGesture = null
      return
    }
    const touch = event.touches[0]
    this._panGesture = {
      clientX: touch.clientX,
      clientY: touch.clientY,
      panX: this.data.panX,
      panY: this.data.panY,
    }
  },

  previewTouchMove(event: WechatMiniprogram.TouchEvent) {
    if (event.touches.length >= 2) {
      if (!this._pinchGesture) this.beginPinch(event.touches[0], event.touches[1])
      this.updatePinch(event.touches[0], event.touches[1])
      return
    }
    if (this._blockGestureUntilRelease) return
    const start = this._panGesture
    if (!start) return
    if (event.touches.length !== 1) {
      this._panGesture = null
      return
    }
    const touch = event.touches[0]
    const draft = this.data.draft
    if (!draft) return
    const extent = getContentExtent(draft.settings.width, draft.settings.height)
    this.setData({
      panX: clampPanOffset(start.panX + touch.clientX - start.clientX, this._boardWidth, this.data.scalePercent, extent.x, draft.settings.width),
      panY: clampPanOffset(start.panY + touch.clientY - start.clientY, this._boardHeight, this.data.scalePercent, extent.y, draft.settings.height),
    })
  },

  previewTouchEnd(event: WechatMiniprogram.TouchEvent) {
    if (this._pinchGesture) {
      if (event.touches.length >= 2) return
      this._pinchGesture = null
      this._panGesture = null
      this._blockGestureUntilRelease = event.touches.length > 0
      return
    }
    if (this._blockGestureUntilRelease) {
      if (event.touches.length === 0) this._blockGestureUntilRelease = false
      return
    }
    this._panGesture = null
  },

  beginPinch(t0: WechatMiniprogram.TouchDetail, t1: WechatMiniprogram.TouchDetail) {
    const board = this._boardRect
    if (!board) return
    const midX = (t0.clientX + t1.clientX) / 2 - board.left
    const midY = (t0.clientY + t1.clientY) / 2 - board.top
    this._pinchGesture = {
      distance: pinchDistance(t0, t1),
      scale: this.data.scalePercent / 100,
      panX: this.data.panX,
      panY: this.data.panY,
      midX,
      midY,
    }
    this._panGesture = null
    this._blockGestureUntilRelease = true
  },

  updatePinch(t0: WechatMiniprogram.TouchDetail, t1: WechatMiniprogram.TouchDetail) {
    const start = this._pinchGesture
    const board = this._boardRect
    const draft = this.data.draft
    if (!start || !board || !draft || start.distance <= 0) return
    const scale = Math.min(MAX_SCALE_PERCENT / 100, Math.max(MIN_SCALE_PERCENT / 100, start.scale * pinchDistance(t0, t1) / start.distance))
    const midX = (t0.clientX + t1.clientX) / 2 - board.left
    const midY = (t0.clientY + t1.clientY) / 2 - board.top
    const contentX = (start.midX - board.width / 2 - start.panX) / start.scale
    const contentY = (start.midY - board.height / 2 - start.panY) / start.scale
    const extent = getContentExtent(draft.settings.width, draft.settings.height)
    const scalePercent = Math.round(scale * 100)
    const panX = clampPanOffset(midX - board.width / 2 - contentX * scale, this._boardWidth, scalePercent, extent.x, draft.settings.width)
    const panY = clampPanOffset(midY - board.height / 2 - contentY * scale, this._boardHeight, scalePercent, extent.y, draft.settings.height)
    this.setData({
      scalePercent,
      panX,
      panY,
      canZoomIn: scalePercent < MAX_SCALE_PERCENT,
      canZoomOut: scalePercent > MIN_SCALE_PERCENT,
    })
  },

  renderPatternPreview() {
    const draft = this.data.draft
    if (!draft) return
    // 图片导出异步返回；丢弃切页、任务状态变化或新绘制后才返回的旧结果。
    const renderId = ++this._previewRenderId
    wx.createSelectorQuery()
      .in(this)
      .select('.ai-generation-result-card__board')
      .fields({ rect: true, size: true })
      .exec((results) => {
        const result = results[0] as PatternPreviewQueryResult | undefined
        if (!result?.width || !result.height) {
          if (renderId === this._previewRenderId) this.setData({ patternRenderError: true })
          return
        }
        this._boardWidth = result.width
        this._boardHeight = result.height
        this._boardRect = result
        const pixelRatio = Math.min(wx.getWindowInfo().pixelRatio || 1, 2)
        loadPatternRenderer()
          .then(({ buildCoordinateTicks, drawPatternOnCanvas }) => {
            if (renderId !== this._previewRenderId) return
            const axisLengthX = Math.max(1, result.width)
            const axisLengthY = Math.max(1, result.height)
            const extent = getContentExtent(draft.settings.width, draft.settings.height)
            this.setData({
              rulerColumns: buildCoordinateTicks(draft.settings.width, draft.settings.height),
              rulerRows: buildCoordinateTicks(draft.settings.height, draft.settings.width),
              panX: clampPanOffset(this.data.panX, axisLengthX, this.data.scalePercent, extent.x, draft.settings.width),
              panY: clampPanOffset(this.data.panY, axisLengthY, this.data.scalePercent, extent.y, draft.settings.height),
            })
            const width = Math.round(result.width * pixelRatio)
            const height = Math.round(result.height * pixelRatio)
            const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
            const context = canvas.getContext('2d') as PatternCanvasContext
            context.scale(pixelRatio, pixelRatio)
            drawPatternOnCanvas(context, result.width, result.height, draft, true)
            wx.canvasToTempFilePath({
              canvas: canvas as unknown as WechatMiniprogram.IAnyObject,
              fileType: 'png',
              width,
              height,
              destWidth: width,
              destHeight: height,
              success: ({ tempFilePath }) => {
                if (renderId !== this._previewRenderId) return
                this.setData({ patternPreviewPath: tempFilePath, patternRenderError: false })
              },
              fail: (error) => {
                if (renderId !== this._previewRenderId) return
                console.error('AI 拼豆图预览导出失败', error)
                this.setData({ patternRenderError: true })
              },
            })
          })
          .catch((error) => {
            if (renderId !== this._previewRenderId) return
            console.error('AI 拼豆图预览绘制失败', error)
            this.setData({ patternRenderError: true })
          })
      })
  },

  async saveWork() {
    const draft = this.data.draft
    if (!draft || this.data.saving) return
    this.setData({ saving: true })
    try {
      const existing = appStore.getSnapshot().works.find((work) => work.id === draft.id)
      const localWork: WorkItem = {
        id: draft.id,
        title: existing?.title ?? '未命名作品',
        coverPath: draft.sourceImagePath,
        generationMode: draft.generationMode,
        updatedAt: Date.now(),
        createdAt: existing?.createdAt ?? draft.createdAt,
        beadCount: draft.cells.filter((cell) => cell.color !== 'transparent').length,
        colorCount: getPaletteColors(draft.cells).length,
        width: draft.settings.width,
        height: draft.settings.height,
        status: 'completed',
      }

      if (!hasCloudSession()) {
        await appStore.saveLocalDraft(draft)
        await appStore.saveWork({ ...localWork, syncStatus: 'guest' })
        wx.showToast({ title: '已保存到本机', icon: 'success' })
      } else {
        try {
          const summary = existing?.syncStatus === 'synced' || existing?.isCloud
            ? await updateCloudWork(existing.id, draft, draft.sourceImagePath, existing.title)
            : await saveNewCloudWork(draft, draft.sourceImagePath, existing?.title ?? '未命名作品')
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
            syncStatus: pending ? 'pending' : 'failed',
            syncError: error instanceof Error ? error.message : '云端保存失败，请稍后重试',
          }, draft)
          wx.showToast({
            title: pending ? '已保存到本机，联网后自动同步' : '已保存到本机，云端保存失败',
            icon: 'none',
          })
        }
      }
      wx.redirectTo({ url: '/packages/result/index' })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '保存失败，请重试', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  goBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({
        url: this._from === 'projects' ? '/pages/projects/index' : '/pages/home/index',
      }),
    })
  },

  backHome() {
    wx.switchTab({ url: '/pages/home/index' })
  },
})
