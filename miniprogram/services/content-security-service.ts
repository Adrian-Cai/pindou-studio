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

export async function checkImageContent(filePath: string): Promise<void> {
  const token = (await ensureLoggedInSession()).token
  try {
    await apiUploadFile({
      path: '/api/content-security/media',
      filePath,
      name: 'file',
      token,
      timeoutMs: 30_000,
    })
  } catch (error) {
    throw normalizeContentSecurityError(error)
  }
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
