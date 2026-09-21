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

export async function generateHunyuanImage(
  input: GenerateHunyuanImageInput,
): Promise<HunyuanImageResult> {
  const prompt = input.prompt.trim()
  if (!prompt) throw new ApiError('请输入提示词', { code: 'INVALID_PROMPT' })
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
