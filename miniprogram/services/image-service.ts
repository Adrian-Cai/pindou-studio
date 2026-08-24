import { DEFAULT_PATTERN_SETTINGS, SAMPLE_PALETTE } from '../config/product'
import type { PatternCell, PatternDraft, PatternSettings } from '../models/pattern'

export class UnsupportedImageFormatError extends Error {
  constructor() {
    super('仅支持 JPG、PNG、WEBP 格式')
    this.name = 'UnsupportedImageFormatError'
  }
}

export async function chooseSourceImage(): Promise<string | null> {
  const result = await wx.chooseMedia({
    count: 1,
    mediaType: ['image'],
    sourceType: ['album', 'camera'],
  })
  const sourceImagePath = result.tempFiles[0]?.tempFilePath ?? null
  if (!sourceImagePath) return null

  const header = await readFileHeader(sourceImagePath)
  if (!isSupportedImageHeader(header)) {
    throw new UnsupportedImageFormatError()
  }

  return sourceImagePath
}

export function createDraft(
  sourceImagePath: string,
  settings: Partial<PatternSettings>,
): PatternDraft {
  const normalizedSettings: PatternSettings = {
    ...DEFAULT_PATTERN_SETTINGS,
    ...settings,
  }

  return {
    id: 'draft-' + Date.now(),
    sourceImagePath,
    createdAt: Date.now(),
    settings: normalizedSettings,
    cells: createSampleCells(12, 12),
  }
}

function createSampleCells(columns: number, rows: number): PatternCell[] {
  const cells: PatternCell[] = []
  const centerX = (columns - 1) / 2
  const centerY = (rows - 1) / 2

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY)
      const index = Math.min(
        SAMPLE_PALETTE.length - 1,
        Math.floor(distance + ((x * 3 + y) % 3)),
      )
      cells.push({ ...SAMPLE_PALETTE[index] })
    }
  }
  return cells
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
