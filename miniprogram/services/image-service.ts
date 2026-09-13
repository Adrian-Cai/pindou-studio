import { DEFAULT_PATTERN_SETTINGS } from '../config/product'
import type { GenerationMode, PatternDraft, PatternSettings } from '../models/pattern'
import { ApiError } from './http-client'
import { generateStandardPatternCells } from './pattern-generation/standard-generator'

export class UnsupportedImageFormatError extends ApiError {
  constructor() {
    super('仅支持 JPG、PNG、WEBP 格式', { code: 'UNSUPPORTED_IMAGE' })
    this.name = 'UnsupportedImageFormatError'
  }
}

export class ImageDecodeError extends ApiError {
  constructor() {
    super('图片无法读取，请换一张重试', { code: 'IMAGE_DECODE_ERROR' })
    this.name = 'ImageDecodeError'
  }
}

export async function chooseSourceImage(): Promise<string | null> {
  let result: WechatMiniprogram.ChooseImageSuccessCallbackResult
  try {
    result = await wx.chooseImage({
      count: 1,
      sizeType: ['original'],
      sourceType: ['album', 'camera'],
    })
  } catch (error) {
    if (isImagePickerCancel(error)) return null
    throw error
  }
  const sourceImagePath = result.tempFilePaths[0] ?? null
  if (!sourceImagePath) return null

  try {
    const header = await readFileHeader(sourceImagePath)
    if (!isSupportedImageHeader(header)) throw new UnsupportedImageFormatError()
  } catch (error) {
    if (error instanceof UnsupportedImageFormatError) throw error
    // 部分真机和 Windows 开发者工具不允许直接读取选择器临时路径，交给 <image> 解码
  }
  return sourceImagePath
}

export async function prepareImageForContentSecurity(sourceImagePath: string): Promise<string> {
  let header: Uint8Array | null = null
  try {
    header = await readFileHeader(sourceImagePath)
    if (!isSupportedImageHeader(header)) throw new UnsupportedImageFormatError()
  } catch (error) {
    if (error instanceof UnsupportedImageFormatError) throw error
    // 部分环境无法直接读取文件头时继续尝试解码
  }

  let sourceWidth: number
  let sourceHeight: number
  try {
    ({ width: sourceWidth, height: sourceHeight } = await getImageInfo(sourceImagePath))
  } catch {
    throw new ImageDecodeError()
  }

  const maxSide = 1_024
  const currentMaxSide = Math.max(sourceWidth, sourceHeight)

  // 如果原图已经是小体积的 JPEG，可直接复用
  if (header && isJpeg(header) && currentMaxSide <= maxSide) {
    const size = await getFileSize(sourceImagePath)
    if (size !== null && size <= 300 * 1024) {
      return sourceImagePath
    }
  }

  try {
    const scale = Math.min(1, maxSide / currentMaxSide)
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))
    const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
    const context = canvas.getContext('2d') as {
      drawImage(image: WechatMiniprogram.Image, x: number, y: number, width: number, height: number): void
    }
    const image = canvas.createImage()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new ImageDecodeError())
      image.src = sourceImagePath
    })
    context.drawImage(image, 0, 0, width, height)

    return await new Promise<string>((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas: canvas as unknown as WechatMiniprogram.IAnyObject,
        fileType: 'jpg',
        quality: 0.8,
        width,
        height,
        destWidth: width,
        destHeight: height,
        success: ({ tempFilePath }) => resolve(tempFilePath),
        fail: reject,
      })
    })
  } catch {
    return compressImageFallback(sourceImagePath)
  }
}

function getFileSize(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      wx.getFileSystemManager().getFileInfo({
        filePath,
        success: ({ size }) => resolve(size),
        fail: () => resolve(null),
      })
    } catch {
      resolve(null)
    }
  })
}

function compressImageFallback(src: string): Promise<string> {
  return new Promise((resolve) => {
    if (typeof wx.compressImage !== 'function') {
      resolve(src)
      return
    }
    wx.compressImage({
      src,
      quality: 80,
      success: ({ tempFilePath }) => resolve(tempFilePath),
      fail: () => resolve(src),
    })
  })
}

function getImageInfo(imagePath: string): Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult> {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src: imagePath, success: resolve, fail: reject })
  })
}

function isImagePickerCancel(error: unknown): boolean {
  if (error instanceof Error) return error.message.toLowerCase().includes('cancel')
  if (typeof error !== 'object' || error === null || !('errMsg' in error)) return false
  const errMsg = (error as { errMsg?: unknown }).errMsg
  return typeof errMsg === 'string' && errMsg.toLowerCase().includes('cancel')
}

export async function createDraft(
  sourceImagePath: string,
  settings: Partial<PatternSettings>,
  generationMode: GenerationMode = 'standard',
): Promise<PatternDraft> {
  const normalizedSettings: PatternSettings = {
    ...DEFAULT_PATTERN_SETTINGS,
    ...settings,
  }
  const cells = await generateStandardPatternCells(sourceImagePath, normalizedSettings)
  const now = Date.now()

  return {
    id: 'draft-' + now,
    sourceImagePath,
    createdAt: now,
    generationMode,
    settings: normalizedSettings,
    cells,
  }
}

/**
 * 创建仅用于等待 AI 结果的临时草稿。
 * 它不代表可保存的作品，真实网格会在 AI 输出完成后由 createDraft 生成。
 */
export function createPendingDraft(
  sourceImagePath: string,
  settings: Partial<PatternSettings>,
): PatternDraft {
  const normalizedSettings: PatternSettings = {
    ...DEFAULT_PATTERN_SETTINGS,
    ...settings,
  }
  const now = Date.now()

  return {
    id: `ai-pending-${now}`,
    sourceImagePath,
    createdAt: now,
    generationMode: 'ai',
    settings: normalizedSettings,
    cells: Array.from(
      { length: normalizedSettings.width * normalizedSettings.height },
      () => ({ color: 'transparent', colorCode: '' }),
    ),
  }
}

function readFileHeader(filePath: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      position: 0,
      length: 12,
      success({ data }) {
        if (typeof data === 'string') {
          reject(new Error('无法读取图片文件头'))
          return
        }
        resolve(new Uint8Array(data))
      },
      fail: reject,
    })
  })
}

export function isSupportedImageHeader(bytes: Uint8Array): boolean {
  return isJpeg(bytes) || isPng(bytes) || isWebp(bytes)
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return signature.every((byte, index) => bytes[index] === byte)
}

function isWebp(bytes: Uint8Array): boolean {
  return hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WEBP')
}

function hasAscii(bytes: Uint8Array, offset: number, expected: string): boolean {
  return [...expected].every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0),
  )
}
