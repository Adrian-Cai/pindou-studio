import { ApiError, apiRequest, apiUploadFile } from './http-client'
import { ensureLoggedInSession } from './session-service'

export interface ImageContentCheck {
  safe: true
  checkId: string
  traceId: string | null
}

export async function checkTextContent(content: string): Promise<void> {
  const token = (await ensureLoggedInSession()).token
  try {
    await apiRequest({
      path: '/api/content-security/text',
      method: 'POST',
      token,
      data: { content },
    })
  } catch (error) {
    throw normalizeContentSecurityError(error)
  }
}

export async function checkImageContent(
  filePath: string,
  onUploadProgress?: (progress: number) => void,
): Promise<ImageContentCheck> {
  let stage: 'login' | 'upload' = 'login'
  try {
    const token = (await ensureLoggedInSession()).token
    stage = 'upload'
    return await uploadWithRetry(filePath, token, onUploadProgress)
  } catch (error) {
    logContentSecurityError(stage === 'login' ? 'login_failed' : 'content_security_upload_failed', error)
    throw normalizeContentSecurityError(error)
  }
}

async function uploadWithRetry(
  filePath: string,
  token: string,
  onUploadProgress?: (progress: number) => void,
): Promise<ImageContentCheck> {
  try {
    const response = await apiUploadFile<unknown>({
      path: '/api/content-security/media',
      filePath,
      name: 'file',
      token,
      timeoutMs: 30_000,
      onProgress: onUploadProgress,
    })
    return parseImageContentCheck(response)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NETWORK_ERROR') {
      await delay(500)
      const response = await apiUploadFile<unknown>({
        path: '/api/content-security/media',
        filePath,
        name: 'file',
        token,
        timeoutMs: 30_000,
        onProgress: onUploadProgress,
      })
      return parseImageContentCheck(response)
    }
    throw error
  }
}

function parseImageContentCheck(value: unknown): ImageContentCheck {
  if (!isRecord(value) || !isRecord(value.check)) {
    throw new ApiError('图片安全检测结果无效，请稍后重试', { code: 'INVALID_RESPONSE' })
  }
  const { safe, checkId, traceId } = value.check
  if (safe !== true || typeof checkId !== 'string' || !checkId.trim() || (traceId !== null && typeof traceId !== 'string')) {
    throw new ApiError('图片安全检测结果无效，请稍后重试', { code: 'INVALID_RESPONSE' })
  }
  return { safe: true, checkId, traceId }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function logContentSecurityError(event: string, error: unknown): void {
  const metadata = error instanceof ApiError
    ? { name: error.name, code: error.code, statusCode: error.statusCode, requestId: error.requestId, details: error.details }
    : { name: error instanceof Error ? error.name : 'UnknownError', code: null, statusCode: null, requestId: null }
  console.error(event, metadata)
}

function normalizeContentSecurityError(error: unknown): ApiError {
  if (error instanceof ApiError && error.code === 'CONTENT_RISKY') {
    return new ApiError('你发布的内容含违规信息，请修改后重试', {
      statusCode: error.statusCode,
      code: error.code,
    })
  }
  return error instanceof ApiError
    ? error
    : new ApiError('内容安全检测暂时不可用，请稍后重试', { code: 'CONTENT_SECURITY_UNAVAILABLE' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
