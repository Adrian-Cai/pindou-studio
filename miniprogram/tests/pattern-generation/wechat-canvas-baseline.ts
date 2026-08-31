import type { PatternCell, PatternSettings } from '../../models/pattern'
import { createDraft } from '../../services/image-service'

interface WechatCanvasCase {
  id: string
  fixture: string
  settings: PatternSettings
}

interface WechatCanvasBaselineRecord {
  id: string
  fixture: string
  sourceWidth: number
  sourceHeight: number
  width: number
  height: number
  colorLimit: number
  brand: string
  cellCount: number
  opaqueCellCount: number
  colorCount: number
  matrixHash: string
  paletteHash: string
  generationTimeMs: number
}

export interface WechatCanvasBaselineOutput {
  schemaVersion: 1
  algorithm: 'standard-v1'
  runtime: 'wechat-offscreen-canvas'
  generatedAt: string
  cases: WechatCanvasBaselineRecord[]
}

const CASES: WechatCanvasCase[] = [
  createCase('square-flat-32-16', '01-square-flat.png', 32, 16),
  createCase('landscape-two-color-64-32', '02-landscape-two-color.png', 64, 32),
  createCase('portrait-two-color-96-32', '03-portrait-two-color.png', 96, 32),
  createCase('alpha-edge-32-16', '04-alpha-edge.png', 32, 16),
  createCase('gradient-128-64', '05-gradient.png', 128, 64),
  createCase('detail-pattern-64-32', '06-detail-pattern.png', 64, 32),
]

export async function runWechatCanvasBaseline(): Promise<WechatCanvasBaselineOutput> {
  const records: WechatCanvasBaselineRecord[] = []

  for (const baselineCase of CASES) {
    const sourcePath = `/test-assets/pattern-generation/${baselineCase.fixture}`
    const sourceInfo = await getImageInfo(sourcePath)
    const startedAt = Date.now()
    const draft = await createDraft(sourcePath, baselineCase.settings)
    const generationTimeMs = Date.now() - startedAt
    const serializedCells = draft.cells.map(serializeCell)
    const palette = derivePalette(draft.cells)

    records.push({
      id: baselineCase.id,
      fixture: baselineCase.fixture,
      sourceWidth: sourceInfo.width,
      sourceHeight: sourceInfo.height,
      width: draft.settings.width,
      height: draft.settings.height,
      colorLimit: draft.settings.colorLimit,
      brand: draft.settings.brand,
      cellCount: draft.cells.length,
      opaqueCellCount: draft.cells.filter((cell) => cell.color !== 'transparent').length,
      colorCount: palette.length,
      matrixHash: fnv1a32(serializedCells.join('|')),
      paletteHash: fnv1a32(palette.join('|')),
      generationTimeMs,
    })
  }

  const output: WechatCanvasBaselineOutput = {
    schemaVersion: 1,
    algorithm: 'standard-v1',
    runtime: 'wechat-offscreen-canvas',
    generatedAt: new Date().toISOString(),
    cases: records,
  }
  const serializedOutput = JSON.stringify(output, null, 2)
  console.info('[Standard V1 WeChat Canvas Baseline]\n' + serializedOutput)
  writeBaselineFile(serializedOutput)
  return output
}

function createCase(
  id: string,
  fixture: string,
  size: number,
  colorLimit: number,
): WechatCanvasCase {
  return {
    id,
    fixture,
    settings: { width: size, height: size, colorLimit, brand: 'MARD' },
  }
}

function getImageInfo(
  sourcePath: string,
): Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult> {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src: sourcePath, success: resolve, fail: reject })
  })
}

function serializeCell(cell: PatternCell): string {
  return `${cell.color}:${cell.colorCode}`
}

function derivePalette(cells: PatternCell[]): string[] {
  const colorsByCode = new Map<string, string>()
  cells.forEach((cell) => {
    if (!cell.colorCode || colorsByCode.has(cell.colorCode)) return
    colorsByCode.set(cell.colorCode, cell.color)
  })
  return [...colorsByCode]
    .sort(([leftCode], [rightCode]) => leftCode.localeCompare(rightCode))
    .map(([colorCode, color]) => `${colorCode}:${color}`)
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function writeBaselineFile(serializedOutput: string): void {
  const outputPath = `${wx.env.USER_DATA_PATH}/standard-v1-wechat-canvas-baseline.json`
  try {
    wx.getFileSystemManager().writeFileSync(outputPath, serializedOutput, 'utf8')
    console.info(`[Standard V1 WeChat Canvas Baseline] 已写入 ${outputPath}`)
  } catch (error) {
    console.warn('[Standard V1 WeChat Canvas Baseline] 写入基线文件失败', error)
  }
}
