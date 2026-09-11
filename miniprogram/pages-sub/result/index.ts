import { DOWNLOAD_CONFIGS } from '../config/download'
import type { DownloadSheetState, DownloadTabConfig } from '../config/download'
import type { DownloadFileType, PatternDraft, WorkItem } from '../../models/pattern'
import {
  createDownloadIdempotencyKey,
  executeCloudDownload,
  friendlyDownloadError,
  recordLocalDownloadResult,
  saveImageToAlbum,
} from '../services/result-download-service'
import {
  cloudSummaryToWorkItem,
  hasCloudSession,
  fetchCloudWork,
  renameCloudWork,
  setCloudFavorite,
} from '../../services/work-service'
import { DAILY_FREE_DOWNLOAD_QUOTA, appStore } from '../../store/app-store'
import { authStore } from '../../store/auth-store'
import { checkTextContent } from '../../services/content-security-service'
import { getCustomNavigationMetrics } from '../../utils/navigation'
import {
  createDraftRenderKey,
  formatDateTime,
  type MaterialItem,
  type ResultSummary,
  summarizeMaterials,
} from './utils'
import {
  DOWNLOAD_CANVAS_WIDTH,
  drawChartImages,
  drawMaterialsDownloadImage,
  drawPaletteDownloadImage,
  drawPreviewImage,
  drawThumbnail,
} from '../services/pattern-render-service'

type ResultTab = 'preview' | 'materials' | 'chart' | 'palette'

interface DownloadRequestEvent extends WechatMiniprogram.CustomEvent {
  detail: {
    fileType: DownloadFileType
  }
}

Page({
  favoriteRefreshToken: 0,

  data: {
    draft: null as PatternDraft | null,
    summary: null as ResultSummary | null,
    materials: [] as MaterialItem[],
    activeTab: 'preview' as ResultTab,
    isFavorite: false,
    favoriteUpdating: false,
    canvasReady: false,
    renderError: false,
    quota: 0,
    dailyFreeQuota: DAILY_FREE_DOWNLOAD_QUOTA,
    quotaTipsOpen: false,
    downloadLoading: false,
    downloadingType: '' as DownloadFileType | '',
    downloadCanvasWidth: DOWNLOAD_CANVAS_WIDTH,
    materialsCanvasHeight: 360,
    paletteCanvasHeight: 420,
    chartWidthRpx: 0,
    chartHeightRpx: 0,
    thumbnailSrc: '' as string,
    previewSrc: '' as string,
    chartSrc: '' as string,
    chartHdSrc: '' as string,
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
    // ── 下载半屏相关状态 ──
    downloadSheetVisible: false,
    downloadSheetState: 'closed' as DownloadSheetState,
    downloadSheetType: '' as DownloadFileType | '',
    currentDownloadConfig: null as DownloadTabConfig | null,
    downloadSheetQuota: 0,
    downloadIdempotencyKey: '',
    savedDownloadedPath: '',
    savedDownloadType: '' as DownloadFileType | '',
  },

  onLoad() {
    this.updateLayoutMetrics()
  },

  onShow() {
    appStore.refreshDownloadQuota()
    const state = appStore.getSnapshot()
    const profileQuota = authStore.getSnapshot().profile?.quota
    const accountQuota = profileQuota?.remaining
    const dailyFreeQuota = profileQuota?.dailyFree ?? DAILY_FREE_DOWNLOAD_QUOTA
    const draft = state.currentDraft
    const work = draft ? state.works.find((item) => item.id === draft.id) : undefined
    const materialSummary = draft
      ? summarizeMaterials(draft)
      : { items: [], totalCount: 0 }
    const materials = materialSummary.items
    const beadCount = materialSummary.totalCount
    const draftRenderKey = draft ? createDraftRenderKey(draft) : ''
    const shouldRenderPatternImages = draftRenderKey !== this.data.renderedDraftKey

    this.setData(
      {
        draft,
        materials,
        quota: accountQuota ?? state.downloadQuota,
        dailyFreeQuota,
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
        ...(shouldRenderPatternImages ? { thumbnailSrc: '', previewSrc: '', chartSrc: '', chartHdSrc: '' } : {}),
      },
      () => {
        if (this.data.canvasReady) this.renderVisibleCanvases()
      },
    )
    void this.refreshServerQuota()
    void this.refreshFavoriteState(work)
  },

  async refreshFavoriteState(work?: WorkItem) {
    if (!work?.isCloud || !hasCloudSession()) return
    const refreshToken = ++this.favoriteRefreshToken
    try {
      const detail = await fetchCloudWork(work.id)
      if (refreshToken !== this.favoriteRefreshToken) return
      await appStore.saveWork(cloudSummaryToWorkItem(detail))
      if (this.data.draft?.id !== detail.id) return
      this.setData({ isFavorite: appStore.getSnapshot().favoriteIds.includes(detail.id) })
    } catch (error) {
      console.warn('刷新作品收藏状态失败，继续使用本地缓存', error)
    }
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

  async refreshServerQuota() {
    const quota = await authStore.refreshQuota()
    if (!quota) return
    appStore.setDownloadQuota(quota.remaining)
    this.setData({ quota: quota.remaining, dailyFreeQuota: quota.dailyFree })
  },

  async getCurrentQuota(): Promise<number> {
    if (authStore.getSnapshot().profile) {
      const quota = await authStore.refreshQuota()
      if (quota) {
        appStore.setDownloadQuota(quota.remaining)
        return quota.remaining
      }
      const cachedQuota = authStore.getSnapshot().profile?.quota.remaining
      if (cachedQuota !== undefined) return cachedQuota
    }
    return appStore.refreshDownloadQuota()
  },

  changeTab(event: WechatMiniprogram.TouchEvent) {
    const activeTab = String(event.currentTarget.dataset.tab) as ResultTab
    if (activeTab === this.data.activeTab) return
    this.setData(
      { activeTab, quotaTipsOpen: false, renderError: false },
      () => this.renderVisibleCanvases(),
    )
  },

  async toggleFavorite() {
    const draft = this.data.draft
    if (!draft || this.data.favoriteUpdating) return
    this.favoriteRefreshToken += 1
    if (!hasCloudSession()) {
      wx.showToast({ title: '收藏失败，请先登录', icon: 'none' })
      return
    }
    if (authStore.getSnapshot().status !== 'authenticated') {
      wx.showToast({ title: '作品正在同步，请稍后重试', icon: 'none' })
      return
    }
    const previousIsFavorite = this.data.isFavorite
    const isFavorite = !this.data.isFavorite
    const work = appStore.getSnapshot().works.find((item) => item.id === draft.id)
    if (!work?.isCloud) {
      wx.showToast({ title: '作品同步失败，请稍后重试', icon: 'none' })
      return
    }

    this.setData({ favoriteUpdating: true })
    try {
      const response = await setCloudFavorite(draft.id, isFavorite)
      const favoritedAt = response?.favoritedAt ? Date.parse(response.favoritedAt) : Date.now()
      await appStore.setFavorite(draft.id, isFavorite, favoritedAt)
      this.setData({ isFavorite })
      wx.showToast({ title: isFavorite ? '已收藏' : '已取消收藏', icon: 'none', duration: 1500 })
      this.setData({ favoriteUpdating: false })
    } catch (error) {
      console.error('切换收藏状态失败', error)
      this.setData({ isFavorite: previousIsFavorite, favoriteUpdating: false })
      wx.showToast({ title: isFavorite ? '收藏失败，请重试' : '取消收藏失败，请重试', icon: 'none' })
    }
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
        if (Array.from(nextTitle).length > 20) {
          wx.showToast({ title: '作品名称不能超过 20 个字符', icon: 'none' })
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
      await checkTextContent(title)
      let savedTitle = title
      if (work.isCloud) {
        const savedWork = await renameCloudWork(work.id, title)
        savedTitle = savedWork.title
        await appStore.saveWork(cloudSummaryToWorkItem(savedWork))
      } else {
        await appStore.saveWork({ ...work, title, updatedAt: Date.now() })
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

  toggleQuotaTips() {
    this.setData({ quotaTipsOpen: !this.data.quotaTipsOpen })
  },

  closeQuotaTips() {
    if (this.data.quotaTipsOpen) this.setData({ quotaTipsOpen: false })
  },

  openMembership() {
    this.closeQuotaTips()
    wx.navigateTo({ url: '/pages-sub/recharge/index' })
  },

  // ── 统一下载交互处理 ──

  async handleRequestDownload(event: DownloadRequestEvent) {
    if (this.data.downloadLoading) return

    const fileType = event.detail.fileType
    const currentQuota = await this.getCurrentQuota()
    if (currentQuota <= 0) {
      this.setData({ quota: 0, quotaTipsOpen: false })
      wx.showModal({
        title: '今日免费次数已用完',
        content: '开通会员后可享无限下载',
        confirmText: '去开通',
        success: ({ confirm }) => {
          if (confirm) this.openMembership()
        },
      })
      return
    }

    const config = DOWNLOAD_CONFIGS[fileType]
    this.setData({
      downloadSheetVisible: true,
      downloadSheetState: 'confirm',
      downloadSheetType: fileType,
      currentDownloadConfig: config,
      downloadSheetQuota: currentQuota,
      downloadIdempotencyKey: createDownloadIdempotencyKey(),
      savedDownloadedPath: '',
      savedDownloadType: '',
      quotaTipsOpen: false,
    })
  },

  handleCancelDownload() {
    if (this.data.downloadSheetState === 'processing') return
    this.setData({
      downloadSheetVisible: false,
      downloadSheetState: 'closed',
      downloadSheetType: '',
      downloadIdempotencyKey: '',
    })
  },

  handleCloseDownloadSheet() {
    if (this.data.downloadSheetState === 'processing') return
    this.setData({
      downloadSheetVisible: false,
      downloadSheetState: 'closed',
      downloadSheetType: '',
      downloadIdempotencyKey: '',
    })
  },

  async handleConfirmDownload() {
    if (this.data.downloadSheetState === 'processing' || this.data.downloadLoading) return

    const fileType = this.data.downloadSheetType
    if (!fileType) return

    const currentQuota = await this.getCurrentQuota()
    if (currentQuota <= 0) {
      this.setData({
        quota: 0,
        downloadSheetVisible: false,
        downloadSheetState: 'closed',
        downloadSheetType: '',
        downloadIdempotencyKey: '',
      })
      wx.showModal({
        title: '今日免费次数已用完',
        content: '开通会员后可享无限下载',
        confirmText: '去开通',
        success: ({ confirm }) => {
          if (confirm) this.openMembership()
        },
      })
      return
    }

    this.setData({
      downloadSheetState: 'processing',
      downloadLoading: true,
      downloadingType: fileType,
    })

    try {
      const filePath = await this.createDownloadImage(fileType)
      await saveImageToAlbum(filePath)

      const draft = this.data.draft
      const summary = this.data.summary
      if (!draft || !summary) throw new Error('作品信息不存在')

      const cloudQuota = await executeCloudDownload(draft, fileType, this.data.downloadIdempotencyKey)
      const nextQuota = cloudQuota !== null
        ? cloudQuota
        : recordLocalDownloadResult(
            draft,
            summary.title,
            summary.colorCount,
            this.data.previewSrc || this.data.thumbnailSrc,
            fileType,
          )
      if (nextQuota === null) throw new Error('下载次数状态已变化，请刷新后重试')
      if (cloudQuota === null) authStore.recordLocalDownload(nextQuota)

      this.setData({
        quota: nextQuota,
        downloadSheetQuota: nextQuota,
        savedDownloadedPath: filePath,
        savedDownloadType: fileType,
        downloadSheetState: 'success',
        downloadLoading: false,
        downloadingType: '',
        downloadIdempotencyKey: '',
      })
    } catch (error) {
      console.error('保存下载文件失败', error)
      wx.showToast({
        title: friendlyDownloadError(error),
        icon: 'none',
      })
      this.setData({
        downloadSheetState: 'confirm',
        downloadLoading: false,
        downloadingType: '',
      })
    }
  },

  handlePreviewDownloadedFile() {
    const savedPath = this.data.savedDownloadedPath
    const fileType = this.data.savedDownloadType

    if (fileType === 'chart' && this.data.chartHdSrc) {
      wx.previewImage({
        urls: [this.data.chartHdSrc],
        current: this.data.chartHdSrc,
      })
      return
    }

    if (savedPath) {
      wx.previewImage({
        urls: [savedPath],
        current: savedPath,
      })
      return
    }

    if (fileType === 'preview' && this.data.previewSrc) {
      wx.previewImage({
        urls: [this.data.previewSrc],
        current: this.data.previewSrc,
      })
    }
  },

  handleCompleteDownloadSheet() {
    this.setData({
      downloadSheetVisible: false,
      downloadSheetState: 'closed',
      downloadSheetType: '',
      downloadIdempotencyKey: '',
      savedDownloadedPath: '',
      savedDownloadType: '',
    })
  },

  async createDownloadImage(fileType: DownloadFileType): Promise<string> {
    const draft = this.data.draft
    if (!draft) throw new Error('当前作品不存在')

    if (fileType === 'preview') {
      if (this.data.previewSrc) return this.data.previewSrc
      const previewSrc = await drawPreviewImage(this, draft)
      this.setData({ previewSrc })
      return previewSrc
    }

    if (fileType === 'chart') {
      if (this.data.chartHdSrc) return this.data.chartHdSrc
      if (this.data.chartSrc) return this.data.chartSrc
      const { chartSrc, chartHdSrc } = await drawChartImages(this, draft)
      this.setData({ chartSrc, chartHdSrc })
      const chartPath = chartHdSrc || chartSrc
      if (!chartPath) throw new Error('施工图生成失败')
      return chartPath
    }

    if (fileType === 'materials') return this.drawMaterialsDownloadFile()
    return this.drawPaletteDownloadFile()
  },

  async drawMaterialsDownloadFile(): Promise<string> {
    const materials = this.data.materials
    const height = 220 + materials.length * 72
    await this.resizeDownloadCanvas({ materialsCanvasHeight: height })
    return drawMaterialsDownloadImage(
      this,
      materials,
      this.data.summary?.title ?? '未命名作品',
      this.data.summary?.beadCount ?? 0,
      height,
    )
  },

  async drawPaletteDownloadFile(): Promise<string> {
    const materials = this.data.materials
    const columns = 4
    const rows = Math.max(1, Math.ceil(materials.length / columns))
    const height = 210 + rows * 190
    await this.resizeDownloadCanvas({ paletteCanvasHeight: height })
    return drawPaletteDownloadImage(
      this,
      materials,
      this.data.summary?.title ?? '未命名作品',
      height,
    )
  },

  resizeDownloadCanvas(patch: { materialsCanvasHeight?: number; paletteCanvasHeight?: number }) {
    return new Promise<void>((resolve) => this.setData(patch, resolve))
  },

  goCreate() {
    wx.switchTab({ url: '/pages/home/index' })
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
        jobs.push(this.renderChartImages(draft))
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
      const [thumbnailSrc, previewSrc] = await Promise.all([
        drawThumbnail(this, draft),
        drawPreviewImage(this, draft),
      ])
      this.setData({ thumbnailSrc, previewSrc })
    } finally {
      this.setData({ patternImagesRendering: false })
    }
  },

  async renderChartImages(draft: PatternDraft) {
    this.setData({ chartImageRendering: true })
    try {
      const { chartSrc, chartHdSrc } = await drawChartImages(this, draft)
      this.setData({ chartSrc, chartHdSrc })
    } finally {
      this.setData({ chartImageRendering: false })
    }
  },

  openChartPreview() {
    const hdSrc = this.data.chartHdSrc
    if (!hdSrc) return
    wx.previewImage({
      urls: [hdSrc],
      current: hdSrc,
    })
  },

  onShareAppMessage() {
    return {
      title: '看看我刚生成的拼豆图纸',
      path: '/pages/home/index',
    }
  },
})
