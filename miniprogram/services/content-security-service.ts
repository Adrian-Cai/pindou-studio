/**
 * 内容安全检测服务封装（文本 / 图片）。
 *
 * 职责：封装 /api/content-security 的文本与图片检测接口；图片检测在遇到网络错误时自动重试一次。
 *       不负责图片选择、也不负责把检测结果关联到 AI 任务（由 ai-generation-flow / session 处理）。
 * 调用方：发布前文本校验、AI 生成前的图片安全检测（其 checkId 作为 securityCheckId 透传给生成接口）。
 * 关键点：仅 NETWORK_ERROR 才重试一次（间隔 500ms），业务类拒绝（如内容含违规）不重试；
 *       检测成功返回 safe=true 与 checkId，供后续 AI 任务关联。
 */
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

/**
 * 上传并检测图片是否合规，返回检测结果（含 checkId）。
 * @param filePath 本地图片路径
 * @param onUploadProgress 上传进度回调
 * @returns 成功时 safe=true 并带 checkId
 * @throws ApiError 网络失败会自动重试一次；内容违规时抛 CONTENT_RISKY
 */
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

/** 把底层错误归一成内容安全的统一错误：违规文案保持友好，其余统一为不可用提示。 */
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
