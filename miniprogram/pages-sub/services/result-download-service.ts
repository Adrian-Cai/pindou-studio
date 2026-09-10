import { ApiError } from '../../services/http-client'
import type { DownloadFileType, PatternDraft } from '../../models/pattern'
import {
  cloudDownloadToLocalRecord,
  createDownload,
} from '../../services/download-service'
import { appStore } from '../../store/app-store'
import { authStore } from '../../store/auth-store'

export interface DownloadCanvasContext {
  fillStyle: string
  font: string
  fillRect(x: number, y: number, width: number, height: number): void
  fillText(text: string, x: number, y: number): void
}

interface MaterialDownloadItem {
  color: string
  colorCode: string
  count: number
  percentage: string
}

interface DownloadHeader {
  width: number
  height: number
  workTitle: string
  fileTitle: string
}

export function drawMaterialsDownload(
  context: DownloadCanvasContext,
  header: DownloadHeader,
  materials: MaterialDownloadItem[],
  beadCount: number,
) {
  drawDownloadHeader(context, header)
  context.fillStyle = '#626573'
  context.font = '24px sans-serif'
  context.fillText(`总计 ${beadCount} 颗 · ${materials.length} 色`, 48, 142)
  context.fillStyle = '#f5f6f8'
  context.fillRect(40, 168, header.width - 80, 48)
  context.fillStyle = '#626573'
  context.font = '22px sans-serif'
  context.fillText('色号', 96, 198)
  context.fillText('颜色', 280, 198)
  context.fillText('数量', 570, 198)
  context.fillText('占比', 760, 198)

  materials.forEach((item, index) => {
    const top = 220 + index * 72
    context.fillStyle = index % 2 === 0 ? '#ffffff' : '#fafafa'
    context.fillRect(40, top, header.width - 80, 72)
    context.fillStyle = item.color
    context.fillRect(250, top + 16, 56, 40)
    context.fillStyle = '#15151a'
    context.font = '24px sans-serif'
    context.fillText(item.colorCode, 96, top + 44)
    context.fillText(item.color, 330, top + 44)
    context.fillText(String(item.count), 570, top + 44)
    context.fillText(item.percentage, 760, top + 44)
  })
}

export function drawPaletteDownload(
  context: DownloadCanvasContext,
  header: DownloadHeader,
  materials: MaterialDownloadItem[],
) {
  drawDownloadHeader(context, header)
  materials.forEach((item, index) => {
    const column = index % 4
    const row = Math.floor(index / 4)
    const left = 40 + column * 210
    const top = 150 + row * 190
    context.fillStyle = item.color
    context.fillRect(left, top, 174, 112)
    context.fillStyle = '#15151a'
    context.font = 'bold 24px sans-serif'
    context.fillText(item.colorCode, left, top + 144)
    context.fillStyle = '#626573'
    context.font = '20px sans-serif'
    context.fillText(`${item.count}颗 · ${item.percentage}`, left, top + 174)
  })
}

export function saveImageToAlbum(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => resolve(),
      fail: (error) => reject(new Error(error.errMsg || '保存失败')),
    })
  })
}

export function friendlyDownloadError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (error instanceof ApiError && error.code === 'QUOTA_INSUFFICIENT') return '下载额度不足，未创建下载记录'
  if (error instanceof ApiError && (error.code === 'UNAUTHORIZED' || error.statusCode === 401)) {
    return '登录状态已失效，请重新登录'
  }
  if (/cancel/i.test(message)) return '已取消保存，未扣次数'
  if (/auth|authorize|permission|deny|denied/i.test(message)) return '未获得相册权限，未扣次数'
  if (/network|timeout/i.test(message)) return '网络异常，未扣次数'
  if (message.includes('次数状态')) return message
  return '保存失败，未扣次数'
}

function drawDownloadHeader(context: DownloadCanvasContext, header: DownloadHeader) {
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, header.width, header.height)
  context.fillStyle = '#15151a'
  context.font = 'bold 34px sans-serif'
  context.fillText(header.fileTitle, 40, 62)
  context.fillStyle = '#626573'
  context.font = '24px sans-serif'
  context.fillText(header.workTitle, 40, 108)
}

export function createDownloadIdempotencyKey(): string {
  return `export-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function recordLocalDownloadResult(
  draft: PatternDraft,
  title: string,
  colorCount: number,
  coverPath: string,
  fileType: DownloadFileType,
): number | null {
  return appStore.completeDownload({
    id: `download_${draft.id}_${fileType}_${Date.now()}`,
    workId: draft.id,
    title,
    coverPath,
    downloadedAt: Date.now(),
    fileType,
    width: draft.settings.width,
    height: draft.settings.height,
    colorCount,
  })
}

export async function executeCloudDownload(
  draft: PatternDraft,
  fileType: DownloadFileType,
  idempotencyKey: string,
): Promise<number | null> {
  const work = appStore.getSnapshot().works.find((item) => item.id === draft.id)
  if (!work?.isCloud) return null
  const result = await createDownload(work.id, fileType, idempotencyKey)
  appStore.addDownloadRecord(cloudDownloadToLocalRecord(result.downloadRecord, work))
  appStore.setDownloadQuota(result.quota.remaining)
  authStore.recordServerDownload(result.quota)
  return result.quota.remaining
}
