import { ApiError, apiRequest, apiUploadFile } from './http-client'
import { ensureLoggedInSession } from './session-service'

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
): Promise<void> {
  let stage: 'login' | 'upload' = 'login'
  try {
    const token = (await ensureLoggedInSession()).token
    stage = 'upload'
    await apiUploadFile({
      path: '/api/content-security/media',
      filePath,
      name: 'file',
      token,
      timeoutMs: 30_000,
      onProgress: onUploadProgress,
    })
  } catch (error) {
    logContentSecurityError(stage === 'login' ? 'login_failed' : 'content_security_upload_failed', error)
    throw normalizeContentSecurityError(error)
  }
}

function logContentSecurityError(event: string, error: unknown): void {
  const metadata = error instanceof ApiError
    ? { name: error.name, code: error.code, statusCode: error.statusCode, requestId: error.requestId }
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
