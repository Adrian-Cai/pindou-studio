import { DEFAULT_PATTERN_SETTINGS } from '../config/product'
import type { PatternDraft, PatternSettings } from '../models/pattern'
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
  } catch {
    let imageInfo: WechatMiniprogram.GetImageInfoSuccessCallbackResult
    try {
      imageInfo = await getImageInfo(sourceImagePath)
    } catch {
      throw new ImageDecodeError()
    }
    if (String(imageInfo.type).toLowerCase() !== 'webp') return sourceImagePath
  }
  if (header && (isJpeg(header) || isPng(header))) return sourceImagePath

  let sourceWidth: number
  let sourceHeight: number
  try {
    ({ width: sourceWidth, height: sourceHeight } = await getImageInfo(sourceImagePath))
  } catch {
    throw new ImageDecodeError()
  }
  const maxSide = 2_048
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
  const context = canvas.getContext('2d') as { drawImage(image: WechatMiniprogram.Image, x: number, y: number, width: number, height: number): void }
  const image = canvas.createImage()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new ImageDecodeError())
    image.src = sourceImagePath
  })
  context.drawImage(image, 0, 0, width, height)
  return new Promise<string>((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas: canvas as unknown as WechatMiniprogram.IAnyObject,
      fileType: 'png',
      width,
      height,
      destWidth: width,
      destHeight: height,
      success: ({ tempFilePath }) => resolve(tempFilePath),
      fail: () => reject(new ImageDecodeError()),
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
    settings: normalizedSettings,
    cells,
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
