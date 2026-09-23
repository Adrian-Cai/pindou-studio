/**
 * 结果页下载服务：绘制材料清单/色板下载图，并把图片存相册、扣减云端/本地下载配额。
 *
 * 职责：drawMaterialsDownload/drawPaletteDownload 负责两种下载图的文字与色块排版（纯 canvas 绘制，被渲染服务调用）；
 *       saveImageToAlbum 存相册；executeCloudDownload 走云端扣费，recordLocalDownloadResult 走本地计数；
 *       不负责图纸网格绘制（那是 pattern-render-service）。
 * 调用方：packages/result/index.ts、pattern-render-service.ts。
 * 关键点：每色坐标按固定行高硬编码排版（materials 72px/行、palette 4 列），与结果页估算的画布高度需对应。
 */
import { ApiError } from '../../../services/http-client'
import type { DownloadFileType, PatternDraft } from '../../../models/pattern'
import {
  cloudDownloadToLocalRecord,
  createDownload,
} from '../../../services/download-service'
import { appStore } from '../../../store/app-store'
import { authStore } from '../../../store/auth-store'

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

/**
 * 绘制材料清单下载图：表头 + 每色一行（色号/颜色块/数量/占比）。
 * 坐标按固定行高排版（每行 72px 起），需与结果页 materialsCanvasHeight 估算一致。
 */
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

/**
 * 绘制色板参考下载图：每色一个色块 + 色号 + 用量，4 列网格排版。
 * 坐标按固定列宽/行高排版（4 列×210px、行高 190px），需与结果页 paletteCanvasHeight 一致。
 */
export function drawPaletteDownload(
  context: DownloadCanvasContext,
  header: DownloadHeader,
  materials: MaterialDownloadItem[],
) {
  drawDownloadHeader(context, header)
  materials.forEach((item, index) => {
    // 4 列网格排布：列=index%4，行=floor(index/4)
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

/** 把临时图片保存到系统相册；用户拒绝授权或取消会 reject。 */
export function saveImageToAlbum(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => resolve(),
      fail: (error) => reject(new Error(error.errMsg || '保存失败')),
    })
  })
}

/** 把下载/保存异常映射成用户友好的提示文案（未扣次数等场景单独说明）。 */
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

/** 生成下载幂等键：时间戳 + 随机串，防止网络重试重复扣费。 */
export function createDownloadIdempotencyKey(): string {
  return `export-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 未登录/非云端作品时，在本地记一笔下载并返回最新本地剩余配额（由 appStore 计算）。
 * @returns 最新剩余下载次数，状态异常返回 null
 */
export function recordLocalDownloadResult(
  draft: PatternDraft,
  title: string,
  colorCount: number,
  coverPath: string,
  fileType: DownloadFileType,
): number | null {
  // 随机分量不能省：同毫秒内连点两次「保存」会算出同一个 id，第二次在 addDownloadRecord
  // 里被视为同一条记录覆盖掉 —— 用户点了两次却只记了一次，本地下载记录对不上实际行为
  return appStore.completeDownload({
    id: `download_${draft.id}_${fileType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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

/**
 * 云端作品下载：带幂等键调用服务端扣费，写本地下载记录并刷新配额。
 * @returns 云端返回的最新剩余配额；非云端作品返回 null（交由本地计数）
 */
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
