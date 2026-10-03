import { DEFAULT_PATTERN_SETTINGS } from '../../../config/product'
import type { PatternDraft } from '../../../models/pattern'
import { appStore } from '../../../store/app-store'
import { createDraft } from '../../../services/image-service'
import { createIdempotencyKey } from '../../../services/ai-task-store'
import {
  createTextGeneration,
  fetchTextGenerationOptions,
  getTextGeneration,
  loadTextGenerationImage,
  textGenerationFailureMessage,
  type TextGeneration,
} from '../../../services/text-generation-service'
import {
  fetchTextImageWork,
  loadTextImageWorkImage,
  saveTextImageWork,
  type TextImageWork,
} from '../../../services/text-image-work-service'

const POLL_INTERVAL_MS = 2_000

Page({
  data: {
    selectedTab: 0,
    taskId: '',
    task: null as TextGeneration | null,
    hasSavedWork: false,
    savedWorkId: '',
    displayPrompt: '',
    referenceImagePath: '',
    loading: true,
    savingWork: false,
    saveErrorMessage: '',
    converting: false,
    errorMessage: '',
  },

  _taskId: '',
  _workId: '',
  _savedImageWork: null as TextImageWork | null,
  _workImagePath: '',
  _timer: 0,
  _visible: false,
  _busy: false,

  onLoad(query?: Record<string, string | undefined>) {
    this._taskId = query?.taskId ?? ''
    this._workId = query?.workId ?? ''
    this.setData({
      taskId: this._taskId,
      hasSavedWork: Boolean(this._workId),
      savedWorkId: this._workId,
      selectedTab: query?.from === 'projects' ? 1 : 0,
    })
    if (!this._taskId && !this._workId) {
      this.setData({ loading: false, errorMessage: '没有找到这条文生图任务' })
      return
    }
  },

  onShow() {
    this._visible = true
    if (this._taskId) void this.refreshTask()
    else if (this._workId) void this.refreshSavedWork()
  },

  onHide() {
    this._visible = false
    this.stopPolling()
  },

  onUnload() {
    this._visible = false
    this.stopPolling()
  },

  async refreshTask() {
    if (!this._visible || this._busy) return
    this._busy = true
    this.setData({ loading: true, errorMessage: '' })
    try {
      const task = await getTextGeneration(this._taskId)
      if (!this._visible) return
      const isPending = task.status === 'queued' || task.status === 'processing'
      const isLoadingImage = task.status === 'succeeded' && !!task.outputFile && !this.data.referenceImagePath
      this.setData({
        task,
        displayPrompt: task.prompt,
        loading: isPending || isLoadingImage,
        errorMessage: task.status === 'failed' ? textGenerationFailureMessage(task.errorCode) : '',
      })
      if (isPending) {
        this.schedulePolling()
      } else if (task.status === 'succeeded' && task.outputFile) {
        if (!this.data.savedWorkId) void this.saveGeneratedWork(task)
        if (this.data.referenceImagePath) return
        try {
          const path = await loadTextGenerationImage(task)
          if (!this._visible) return
          this.setData({ referenceImagePath: path, loading: false, errorMessage: '' })
        } catch {
          if (this._visible) this.setData({ loading: false, errorMessage: '参考图已经生成，但暂时加载失败。请检查网络后重新读取，不会重复扣除额度。' })
        }
      }
    } catch (error) {
      if (!this._visible) return
      this.setData({ loading: false, errorMessage: error instanceof Error ? error.message : '任务读取失败，请重试' })
    } finally {
      this._busy = false
    }
  },

  async saveGeneratedWork(task: TextGeneration) {
    if (task.status !== 'succeeded' || this.data.savedWorkId || this.data.savingWork) return
    this.setData({ savingWork: true, saveErrorMessage: '' })
    try {
      const work = await saveTextImageWork(task.id)
      this.setData({
        hasSavedWork: true,
        savedWorkId: work.id,
        savingWork: false,
        saveErrorMessage: '',
      })
    } catch (error) {
      console.error('保存文生图作品失败', error)
      this.setData({
        savingWork: false,
        saveErrorMessage: error instanceof Error ? error.message : '保存到作品失败，请重试',
      })
    }
  },

  async refreshSavedWork() {
    if (!this._visible || this._busy || !this._workId) return
    this._busy = true
    this.setData({ loading: true, errorMessage: '' })
    try {
      const work = await fetchTextImageWork(this._workId)
      if (!this._visible) return
      this._savedImageWork = work
      this.setData({
        hasSavedWork: true,
        savedWorkId: work.id,
        displayPrompt: work.prompt,
        referenceImagePath: work.coverUrl,
        loading: false,
      })
    } catch (error) {
      if (!this._visible) return
      this.setData({ loading: false, errorMessage: error instanceof Error ? error.message : '作品读取失败，请重试' })
    } finally {
      this._busy = false
    }
  },

  schedulePolling() {
    this.stopPolling()
    this._timer = setTimeout(() => void this.refreshTask(), POLL_INTERVAL_MS) as unknown as number
  },

  stopPolling() {
    if (this._timer) clearTimeout(this._timer)
    this._timer = 0
  },

  async retry() {
    const task = this.data.task
    if (!task || this.data.loading) return
    this.setData({ loading: true, errorMessage: '' })
    try {
      const options = await fetchTextGenerationOptions()
      const size = options.sizes.includes(task.size) ? task.size : options.defaultSize
      const next = await createTextGeneration(task.prompt, createIdempotencyKey(), size)
      this._taskId = next.id
      this.setData({
        taskId: next.id,
        task: next,
        hasSavedWork: false,
        savedWorkId: '',
        displayPrompt: next.prompt,
        referenceImagePath: '',
        savingWork: false,
        saveErrorMessage: '',
      })
      await this.refreshTask()
    } catch (error) {
      this.setData({ loading: false, errorMessage: error instanceof Error ? error.message : '重新生成失败，请重试' })
    }
  },

  async createPattern() {
    const task = this.data.task
    const savedWorkId = this.data.savedWorkId
    if ((!task && !savedWorkId) || (task && task.status !== 'succeeded')
      || !this.data.referenceImagePath || !savedWorkId || this.data.savingWork || this.data.converting) return
    this.setData({ converting: true })
    wx.showLoading({ title: '正在生成拼豆图', mask: true })
    try {
      let source = this.data.referenceImagePath
      if (this._workId) {
        const savedWork = this._savedImageWork ?? await fetchTextImageWork(savedWorkId)
        source = this._workImagePath || await loadTextImageWorkImage(savedWork)
        this._workImagePath = source
      }
      const draft: PatternDraft = {
        ...await createDraft(source, DEFAULT_PATTERN_SETTINGS, 'standard'),
        creationSource: 'text',
        sourcePrompt: task?.prompt ?? this.data.displayPrompt,
      }
      await appStore.saveLocalDraft(draft, false)
      await appStore.setCurrentDraft(draft)
      wx.redirectTo({ url: '/packages/editor/index' })
    } catch (error) {
      console.error('文生图参考图转拼豆失败', error)
      wx.showToast({ title: error instanceof Error ? error.message : '拼豆图生成失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ converting: false })
    }
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: this.data.selectedTab === 1 ? '/pages/projects/index' : '/pages/home/index' }) })
  },

  handleReferenceImageError(event: WechatMiniprogram.TouchEvent) {
    if (event.currentTarget.dataset.src !== this.data.referenceImagePath) return
    this.setData({
      referenceImagePath: '',
      errorMessage: '参考图暂时无法显示，请重新读取。',
    })
  },

  retrySaveWork() {
    const task = this.data.task
    if (task?.status === 'succeeded') void this.saveGeneratedWork(task)
  },

  refreshCurrent() {
    if (this._taskId) void this.refreshTask()
    else if (this._workId) void this.refreshSavedWork()
  },
})
