import { DEFAULT_PATTERN_SETTINGS } from '../../../config/product'
import type { PatternDraft } from '../../../models/pattern'
import { appStore } from '../../../store/app-store'
import { createDraft } from '../../../services/image-service'
import { createIdempotencyKey } from '../../../services/ai-task-store'
import {
  consumeTextGeneration,
  createTextGeneration,
  fetchTextGenerationOptions,
  getTextGeneration,
  loadTextGenerationImage,
  textGenerationFailureMessage,
  type TextGeneration,
} from '../../../services/text-generation-service'

const POLL_INTERVAL_MS = 2_000

Page({
  data: {
    selectedTab: 0,
    taskId: '',
    task: null as TextGeneration | null,
    referenceImagePath: '',
    loading: true,
    converting: false,
    errorMessage: '',
  },

  _taskId: '',
  _timer: 0,
  _visible: false,
  _busy: false,

  onLoad(query?: Record<string, string | undefined>) {
    this._taskId = query?.taskId ?? ''
    this.setData({
      taskId: this._taskId,
      selectedTab: query?.from === 'projects' ? 1 : 0,
    })
    if (!this._taskId) {
      this.setData({ loading: false, errorMessage: '没有找到这条文生图任务' })
      return
    }
  },

  onShow() {
    this._visible = true
    if (this._taskId) void this.refreshTask()
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
      this.setData({
        task,
        loading: false,
        errorMessage: task.status === 'failed' ? textGenerationFailureMessage(task.errorCode) : '',
      })
      if (task.status === 'queued' || task.status === 'processing') {
        this.schedulePolling()
      } else if (task.status === 'succeeded' && task.outputFile && !this.data.referenceImagePath) {
        try {
          const path = await loadTextGenerationImage(task)
          if (!this._visible) return
          this.setData({ referenceImagePath: path, errorMessage: '' })
        } catch {
          if (this._visible) this.setData({ errorMessage: '参考图已经生成，但暂时加载失败。请检查网络后重新读取，不会重复扣除额度。' })
        }
      }
    } catch (error) {
      if (!this._visible) return
      this.setData({ loading: false, errorMessage: error instanceof Error ? error.message : '任务读取失败，请重试' })
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
      this.setData({ taskId: next.id, task: next, referenceImagePath: '' })
      await this.refreshTask()
    } catch (error) {
      this.setData({ loading: false, errorMessage: error instanceof Error ? error.message : '重新生成失败，请重试' })
    }
  },

  async createPattern() {
    const task = this.data.task
    const source = this.data.referenceImagePath
    if (!task || task.status !== 'succeeded' || !source || this.data.converting) return
    this.setData({ converting: true })
    wx.showLoading({ title: '正在生成拼豆图', mask: true })
    try {
      const draft: PatternDraft = {
        ...await createDraft(source, DEFAULT_PATTERN_SETTINGS, 'standard'),
        creationSource: 'text',
        sourcePrompt: task.prompt,
      }
      await appStore.saveLocalDraft(draft, false)
      await appStore.setCurrentDraft(draft)
      try {
        await consumeTextGeneration(task.id)
      } catch (error) {
        console.warn('文生图任务已生成草稿，但恢复任务标记失败', error)
      }
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
})
