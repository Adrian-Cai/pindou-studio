/**
 * 图片前置处理：选图、校验格式、压缩/转码、以及由图片生成图纸草稿。
 *
 * 职责：封装 wx.chooseImage 选图、按文件头校验 JPG/PNG/WEBP、把大图压缩到最长边
 *       1024 用于内容安全与上传、并调用标准生成流程产出 PatternDraft；不负责云端读写与下载。
 * 调用方：生成页（standard / AI）在拿到用户图片后调用。
 * 关键点：部分真机/开发者工具禁止直接读选择器临时路径文件头，此时跳过校验交由 <image> 解码；
 *       persistImage 负责把临时路径落到 USER_DATA_PATH，AI 任务的封面与重试都依赖它。
 */
import { DEFAULT_PATTERN_SETTINGS } from '../config/product'
import type { GenerationMode, PatternDraft, PatternSettings } from '../models/pattern'
import { ApiError } from './http-client'
import { generateStandardPatternCells } from './pattern-generation/standard-generator'
import { aiImageDirectoryPath } from './ai-task-store'

/** 不支持的图片格式错误（文件头校验失败）。 */
export class UnsupportedImageFormatError extends ApiError {
  constructor() {
    super('仅支持 JPG、PNG、WEBP 格式', { code: 'UNSUPPORTED_IMAGE' })
    this.name = 'UnsupportedImageFormatError'
  }
}

/** 图片解码失败错误（无法获取尺寸或绘制）。 */
export class ImageDecodeError extends ApiError {
  constructor() {
    super('图片无法读取，请换一张重试', { code: 'IMAGE_DECODE_ERROR' })
    this.name = 'ImageDecodeError'
  }
}

/**
 * 调起相册/相机选图，并做格式校验，返回临时路径；用户取消返回 null。
 * @returns 选中的原图临时路径，或 null（取消/无图）
 */
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

/**
 * 把原图处理成适合内容安全检测与上传的版本：校验格式、小体积 JPEG 直接复用，
 * 否则离屏 canvas 缩放到最长边 1024 再转 jpg(0.8)，失败回退 wx.compressImage。
 * @param sourceImagePath 原图临时路径
 * @returns 处理后图片的临时路径
 */
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

  // 小体积 JPEG（≤300KB 且最长边已 ≤1024）可直接上传，省一次压缩
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

/**
 * 由图片 + 设置生成一份图纸草稿。
 *
 * 注意 `generationMode` **只作为元信息写进草稿**，不改变调用哪个引擎：
 * 无论 standard 还是 ai，图纸一律由 `generateStandardPatternCells` 产出 ——
 * AI 模式是「先用 AI 生成一张图，再把这张图转成拼豆网格」，转网格这一步与标准模式同源。
 * @param sourceImagePath 已处理的原图路径
 * @param settings 图纸设置（与默认值合并）
 * @param generationMode 生成模式，默认 'standard'
 * @param options.id 指定草稿 ID；AI 任务需要让草稿 ID 与作品 ID（taskId）一致
 */
export async function createDraft(
  sourceImagePath: string,
  settings: Partial<PatternSettings>,
  generationMode: GenerationMode = 'standard',
  options?: { id?: string },
): Promise<PatternDraft> {
  const normalizedSettings: PatternSettings = {
    ...DEFAULT_PATTERN_SETTINGS,
    ...settings,
  }
  const cells = await generateStandardPatternCells(sourceImagePath, normalizedSettings)
  const now = Date.now()

  return {
    id: options?.id?.trim() || 'draft-' + now,
    sourceImagePath,
    createdAt: now,
    generationMode,
    settings: normalizedSettings,
    cells,
  }
}

/**
 * 把临时图片复制到永久目录（wx.env.USER_DATA_PATH），避免 App 重启后临时路径失效。
 * 复制失败时回退原路径——退化成本地的旧行为，不该让用户连生成都发起不了。
 * @param sourceImagePath 待永久化的图片路径
 * @returns 可长期使用的图片路径
 */
export async function persistImage(sourceImagePath: string): Promise<string> {
  const source = sourceImagePath.trim()
  if (!source) return sourceImagePath
  const userPath = wx.env.USER_DATA_PATH
  if (source.startsWith(userPath)) return source

  // 目录名与清理逻辑共用同一个常量，避免两边各写一份导致孤儿文件扫不到
  const directory = aiImageDirectoryPath()
  const target = `${directory}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}${imageExtension(source)}`
  try {
    ensureDirectory(directory)
    await copyFile(source, target)
    return target
  } catch (error) {
    console.warn('图片永久化失败，回退使用原路径', error)
    return source
  }
}

function ensureDirectory(directory: string): void {
  const fs = wx.getFileSystemManager()
  // 目录已存在时 mkdirSync 仍会抛 "file already exists"（微信已知行为，recursive:true 也拦不住），
  // 先判存在可彻底消除这条噪音告警；真正的建目录失败（权限/磁盘）才需要告警
  try {
    fs.accessSync(directory)
    return
  } catch {
    // 目录不存在，继续创建
  }
  try {
    fs.mkdirSync(directory, true)
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    if (!/already exists/i.test(errMsg)) {
      console.warn('创建图片目录失败', error)
    }
  }
}

function copyFile(srcPath: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().copyFile({
      srcPath,
      destPath,
      success: () => resolve(),
      fail: (error) => reject(error instanceof Error ? error : new Error(String(error?.errMsg ?? 'copyFile failed'))),
    })
  })
}

function imageExtension(filePath: string): string {
  const matched = /\.(\w+)$/u.exec(filePath)
  const extension = matched?.[1]?.toLowerCase()
  if (extension === 'png' || extension === 'webp' || extension === 'jpeg') return `.${extension}`
  return '.jpg'
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

/** 判断文件头字节是否为受支持的 JPG / PNG / WEBP 格式。 */
export function isSupportedImageHeader(bytes: Uint8Array): boolean {
  return isJpeg(bytes) || isPng(bytes) || isWebp(bytes)
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function isPng(bytes: Uint8Array): boolean {
  // PNG 固定 8 字节文件签名
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
