/**
 * 混元生图 Cloud Function 调用封装（文生图，区别于拼豆 AI 生成主链路）。
 *
 * 职责：调用云函数 generateImage 根据 prompt 生成图片，拿到 fileID 后再换取临时访问 URL。
 *       不负责拼豆网格转换（那是标准图案引擎的事），也不做内容安全检测。
 * 调用方：需要文生图能力的入口（部分模板/创作场景）。
 * 关键点：prompt 长度上限 500 字；云函数调用失败统一收口为 IMAGE_GENERATION_FAILED / CLOUD_FUNCTION_ERROR；
 *       云函数返回 error 字段时优先采用其文案。
 */
import { initCloud } from '../config/cloud'
import { ApiError } from './http-client'

export const HUNYUAN_IMAGE_FUNCTION_NAME = 'generateImage'

export type HunyuanImageSize = '1024x1024' | '1280x720' | '720x1280' | '1280x1280'

export interface GenerateHunyuanImageInput {
  prompt: string
  size?: HunyuanImageSize
}

export interface HunyuanImageResult {
  fileID: string
  url: string
  contentType: string
  size: number
  revisedPrompt: string
}

interface CloudFunctionResult {
  fileID?: unknown
  contentType?: unknown
  size?: unknown
  revisedPrompt?: unknown
  error?: unknown
  code?: unknown
}

/**
 * 调用混元生图云函数生成图片，并返回可访问的临时 URL。
 * @param input 提示词与可选尺寸（缺省 1024x1024）
 * @returns 含 fileID、url、contentType、size、revisedPrompt 的结果
 * @throws ApiError 提示词为空/过长、云函数失败、返回数据非法、临时 URL 获取失败
 */
export async function generateHunyuanImage(
  input: GenerateHunyuanImageInput,
): Promise<HunyuanImageResult> {
  const prompt = input.prompt.trim()
  if (!prompt) throw new ApiError('请输入提示词', { code: 'INVALID_PROMPT' })
  // 提示词上限 500 字，超出直接拦截
  if (prompt.length > 500) {
    throw new ApiError('提示词最多 500 字', { code: 'INVALID_PROMPT' })
  }

  initCloud()
  let response: ICloud.CallFunctionResult
  try {
    response = await wx.cloud.callFunction({
      name: HUNYUAN_IMAGE_FUNCTION_NAME,
      data: { prompt, size: input.size ?? '1024x1024' },
      slow: true,
    })
  } catch (error) {
    throw new ApiError('图片生成失败，请检查网络后重试', {
      code: 'CLOUD_FUNCTION_ERROR',
      details: { rawMessage: errorMessage(error) },
    })
  }

  const result = parseCloudFunctionResult(response.result)
  if (typeof result.error === 'string' && result.error) {
    throw new ApiError(result.error, {
      code: typeof result.code === 'string' ? result.code : 'IMAGE_GENERATION_FAILED',
    })
  }
  if (result.error !== undefined) {
    throw new ApiError('图片生成失败，请稍后重试', { code: 'IMAGE_GENERATION_FAILED' })
  }
  if (
    typeof result.fileID !== 'string'
    || typeof result.contentType !== 'string'
    || !isNonNegativeInteger(result.size)
    || typeof result.revisedPrompt !== 'string'
  ) {
    throw new ApiError('生图服务返回了无法识别的数据', { code: 'INVALID_RESPONSE' })
  }

  const url = await getCloudFileUrl(result.fileID)
  return {
    fileID: result.fileID,
    url,
    contentType: result.contentType,
    size: result.size,
    revisedPrompt: result.revisedPrompt,
  }
}

async function getCloudFileUrl(fileID: string): Promise<string> {
  try {
    const response = await wx.cloud.getTempFileURL({ fileList: [fileID] })
    const file = response.fileList[0]
    // 云存储状态 0 表示可用，否则视为获取失败
    if (!file || file.status !== 0 || !file.tempFileURL) {
      throw new Error(file?.errMsg || '云存储文件地址获取失败')
    }
    return file.tempFileURL
  } catch (error) {
    throw new ApiError('图片已生成，但暂时无法读取云存储文件', {
      code: 'CLOUD_FILE_URL_ERROR',
      details: { rawMessage: errorMessage(error) },
    })
  }
}

function parseCloudFunctionResult(value: ICloud.CallFunctionResult['result']): CloudFunctionResult {
  if (!isRecord(value)) {
    throw new ApiError('生图服务返回了无法识别的数据', { code: 'INVALID_RESPONSE' })
  }
  return value
}

function isRecord(value: unknown): value is CloudFunctionResult {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (isRecord(error) && typeof error.error === 'string') return error.error
  return 'unknown error'
}
