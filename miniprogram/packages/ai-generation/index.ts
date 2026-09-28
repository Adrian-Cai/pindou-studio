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
import type { PatternCanvasContext } from '../editor/services/pattern-renderer'
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

interface PatternPreviewCanvas {
  width: number
  height: number
  getContext(type: '2d'): PatternCanvasContext
}

interface PatternPreviewQueryResult {
  node: PatternPreviewCanvas
  width: number
  height: number
}

const GENERATING_STATUSES: ReadonlySet<AiTaskStatus> = new Set<AiTaskStatus>([
  'uploading',
  'submitting',
  'queued',
  'processing',
  'downloading',
  'converting',
])

const DEFAULT_TIP = '正在为你优化图片细节，生成完成后即可开始编辑'

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
    tipText: DEFAULT_TIP,
    /** 成功态在当前页面直接展示结果，编辑面板随草稿就绪切换为可用。 */
    draft: null as PatternDraft | null,
    editorReady: false,
    patternCanvasReady: false,
    patternRenderError: false,
    activeTool: 'pencil',
    scalePercent: 100,
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
    this.unsubscribe()
  },

  onUnload() {
    this._visible = false
    this.unsubscribe()
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
    this.setData({
      isQueued,
      isGenerating,
      isSucceeded,
      isFailed,
      progress: view.progress,
      queuePosition: view.queuePosition,
      stateTitle: view.stateTitle,
      stateDescription: view.stateDescription,
      tipText: DEFAULT_TIP,
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
        patternCanvasReady: false,
        patternRenderError: false,
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
    this.setData({
      draft,
      editorReady: true,
      patternCanvasReady: false,
      patternRenderError: false,
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
    const next = Math.min(300, this.data.scalePercent + 20)
    this.setData({
      scalePercent: next,
      canZoomIn: next < 300,
      canZoomOut: next > 100,
    })
  },

  zoomOut() {
    const next = Math.max(100, this.data.scalePercent - 20)
    this.setData({
      scalePercent: next,
      canZoomIn: next < 300,
      canZoomOut: next > 100,
    })
  },

  renderPatternPreview() {
    const draft = this.data.draft
    if (!draft) return
    wx.createSelectorQuery()
      .in(this)
      .select('#aiPatternCanvas')
      .fields({ node: true, size: true })
      .exec((results) => {
        const result = results[0] as PatternPreviewQueryResult | undefined
        if (!result?.node || !result.width || !result.height) {
          this.setData({ patternRenderError: true })
          return
        }
        const pixelRatio = Math.min(wx.getWindowInfo().pixelRatio || 1, 2)
        loadPatternRenderer()
          .then(({ drawPatternOnCanvas }) => {
            result.node.width = Math.round(result.width * pixelRatio)
            result.node.height = Math.round(result.height * pixelRatio)
            const context = result.node.getContext('2d')
            context.scale(pixelRatio, pixelRatio)
            drawPatternOnCanvas(context, result.width, result.height, draft, true)
            this.setData({ patternCanvasReady: true })
          })
          .catch((error) => {
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
