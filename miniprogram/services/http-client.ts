import { ApiConfigurationError, buildApiUrl } from '../config/api'

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface ApiRequestOptions {
  path: string
  method?: HttpMethod
  data?: WechatMiniprogram.IAnyObject | string | ArrayBuffer
  token?: string
  timeoutMs?: number
  headers?: Readonly<Record<string, string>>
}

interface ApiUploadOptions {
  path: string
  filePath: string
  name: string
  formData?: Readonly<Record<string, string>>
  token?: string
  timeoutMs?: number
  onProgress?: (progress: number) => void
}

interface ApiErrorBody {
  error?: {
    code?: unknown
    message?: unknown
    requestId?: unknown
    details?: unknown
  }
}

export class ApiError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly requestId: string | null
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    message: string,
    options: {
      statusCode?: number
      code?: string
      requestId?: string | null
      details?: Readonly<Record<string, unknown>>
    } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = options.statusCode ?? 0
    this.code = options.code ?? 'UNKNOWN_ERROR'
    this.requestId = options.requestId ?? null
    this.details = options.details ?? {}
  }
}

export function apiRequest<T>(options: ApiRequestOptions): Promise<T> {
  let url: string
  try {
    url = buildApiUrl(options.path)
  } catch (error) {
    const message = error instanceof ApiConfigurationError ? error.message : 'API 地址配置无效'
    return Promise.reject(new ApiError(message, { code: 'API_CONFIGURATION_ERROR' }))
  }

  return new Promise<T>((resolve, reject) => {
    const header: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...options.headers,
    }
    if (options.token) header.authorization = `Bearer ${options.token}`

    wx.request({
      url,
      method: options.method as WechatMiniprogram.RequestOption['method'] ?? 'GET',
      data: options.data,
      header,
      timeout: options.timeoutMs ?? 10_000,
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data as T)
          return
        }
        reject(createApiError(response.statusCode, response.data))
      },
      fail: () => {
        reject(new ApiError('网络连接失败，请检查网络后重试', { code: 'NETWORK_ERROR' }))
      },
    })
  })
}

export function apiUploadFile<T>(options: ApiUploadOptions): Promise<T> {
  let url: string
  try {
    url = buildApiUrl(options.path)
  } catch (error) {
    const message = error instanceof ApiConfigurationError ? error.message : 'API 地址配置无效'
    return Promise.reject(new ApiError(message, { code: 'API_CONFIGURATION_ERROR' }))
  }

  return new Promise<T>((resolve, reject) => {
    const header: Record<string, string> = { accept: 'application/json' }
    if (options.token) header.authorization = `Bearer ${options.token}`
    const task = wx.uploadFile({
      url,
      filePath: options.filePath,
      name: options.name,
      formData: { ...options.formData },
      header,
      timeout: options.timeoutMs ?? 30_000,
      success: (response) => {
        let body: unknown
        try {
          body = response.data ? JSON.parse(response.data) as unknown : {}
        } catch {
          reject(new ApiError('服务返回了无法识别的数据，请稍后重试', {
            statusCode: response.statusCode,
            code: 'INVALID_RESPONSE',
          }))
          return
        }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(body as T)
          return
        }
        reject(createApiError(response.statusCode, body))
      },
      fail: () => {
        reject(new ApiError('图片上传失败，请检查网络后重试', { code: 'NETWORK_ERROR' }))
      },
    })
    if (options.onProgress) {
      task.onProgressUpdate(({ progress }) => options.onProgress?.(progress))
    }
  })
}

function createApiError(statusCode: number, value: unknown): ApiError {
  const body = isRecord(value) ? value as ApiErrorBody : {}
  const error = body.error
  const code = typeof error?.code === 'string' ? error.code : `HTTP_${statusCode}`
  const message = typeof error?.message === 'string' ? error.message : '服务请求失败，请稍后重试'
  const requestId = typeof error?.requestId === 'string' ? error.requestId : null
  const details = isRecord(error?.details) ? error.details : {}
  return new ApiError(message, { statusCode, code, requestId, details })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
