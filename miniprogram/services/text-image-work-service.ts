import { normalizeCoverUrl } from '../config/api'
import { persistImage } from './image-service'
import { ApiError, apiRequest } from './http-client'
import { requireLoggedInSession } from './session-service'

/** 服务端持久化的文生图原图作品，不包含拼豆网格。 */
export interface TextImageWork {
  id: string
  title: string
  prompt: string
  coverUrl: string
  width: number
  height: number
  createdAt: string
  updatedAt: string
}

interface TextImageWorkListResponse {
  total: number
  page: number
  pageSize: number
  items: TextImageWork[]
}

/** 成功生成后立即把服务端临时输出转成长期作品；重复调用返回同一条作品。 */
export async function saveTextImageWork(sourceJobId: string): Promise<TextImageWork> {
  const session = requireLoggedInSession()
  const response = await apiRequest<unknown>({
    path: '/api/works/text-images',
    method: 'POST',
    token: session.token,
    data: { sourceJobId },
    timeoutMs: 60_000,
  })
  return parseTextImageWork(response)
}

/** 读取账号下已保存的文生图原图。 */
export async function fetchTextImageWorks(page = 1, pageSize = 50): Promise<TextImageWorkListResponse> {
  const session = requireLoggedInSession()
  const response = await apiRequest<unknown>({
    path: `/api/works/text-images?page=${page}&pageSize=${pageSize}`,
    token: session.token,
  })
  if (!isRecord(response) || !isNonNegativeInteger(response.total)
    || !isPositiveInteger(response.page) || !isPositiveInteger(response.pageSize) || !Array.isArray(response.items)) {
    throw invalidResponse()
  }
  return {
    total: response.total,
    page: response.page,
    pageSize: response.pageSize,
    items: response.items.map(parseTextImageWork),
  }
}

/** 读取一条文生图原图作品。 */
export async function fetchTextImageWork(workId: string): Promise<TextImageWork> {
  const session = requireLoggedInSession()
  return parseTextImageWork(await apiRequest<unknown>({
    path: `/api/works/text-images/${encodeURIComponent(workId)}`,
    token: session.token,
  }))
}

/** 删除一条文生图原图作品。 */
export async function deleteTextImageWork(workId: string): Promise<void> {
  const session = requireLoggedInSession()
  await apiRequest<unknown>({
    path: `/api/works/text-images/${encodeURIComponent(workId)}`,
    method: 'DELETE',
    token: session.token,
  })
}

/** 下载长期保存的原图到本机，用于后续转换成拼豆图纸。 */
export async function loadTextImageWorkImage(work: TextImageWork): Promise<string> {
  const response = await new Promise<WechatMiniprogram.DownloadFileSuccessCallbackResult>((resolve, reject) => {
    wx.downloadFile({
      url: work.coverUrl,
      timeout: 60_000,
      success: (result) => {
        if (result.statusCode !== 200 || !result.tempFilePath) {
          reject(new ApiError('文生图原图读取失败，请检查网络后重试', { statusCode: result.statusCode, code: 'NETWORK_ERROR' }))
          return
        }
        resolve(result)
      },
      fail: reject,
    })
  })
  return persistImage(response.tempFilePath)
}

function parseTextImageWork(value: unknown): TextImageWork {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.title !== 'string'
    || typeof value.prompt !== 'string'
    || typeof value.coverUrl !== 'string'
    || !isPositiveInteger(value.width)
    || !isPositiveInteger(value.height)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw invalidResponse()
  }
  return {
    id: value.id,
    title: value.title,
    prompt: value.prompt,
    coverUrl: normalizeCoverUrl(value.coverUrl),
    width: value.width,
    height: value.height,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function invalidResponse(): ApiError {
  return new ApiError('服务返回了无法识别的文生图作品数据', { code: 'INVALID_RESPONSE' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
