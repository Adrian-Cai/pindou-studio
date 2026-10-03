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

/** 单个用例失败不应中断整轮基线：缺一张图就什么都不产，排查成本远高于少一条记录。 */
interface BaselineFailure {
  id: string
  fixture: string
  error: string
}

export interface WechatCanvasBaselineOutput {
  schemaVersion: 1
  algorithm: 'standard-v1'
  runtime: 'wechat-offscreen-canvas'
  generatedAt: string
  cases: WechatCanvasBaselineRecord[]
  failures: BaselineFailure[]
}

/** 测试素材目录；换环境只需改这一处。 */
const TEST_ASSETS_DIR = '/test-assets/pattern-generation'

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
  const failures: BaselineFailure[] = []

  for (const baselineCase of CASES) {
    try {
      records.push(await runSingleCase(baselineCase))
    } catch (error) {
      // 记录后继续跑剩下的用例，保证部分结果仍可用
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[Standard V1 WeChat Canvas Baseline] 用例 ${baselineCase.id} 失败：${message}`)
      failures.push({ id: baselineCase.id, fixture: baselineCase.fixture, error: message })
    }
  }

  const output: WechatCanvasBaselineOutput = {
    schemaVersion: 1,
    algorithm: 'standard-v1',
    runtime: 'wechat-offscreen-canvas',
    generatedAt: new Date().toISOString(),
    cases: records,
    failures,
  }
  const serializedOutput = JSON.stringify(output, null, 2)
  console.info('[Standard V1 WeChat Canvas Baseline]\n' + serializedOutput)
  writeBaselineFile(serializedOutput)
  return output
}

async function runSingleCase(baselineCase: WechatCanvasCase): Promise<WechatCanvasBaselineRecord> {
  const sourcePath = `${TEST_ASSETS_DIR}/${baselineCase.fixture}`
  const sourceInfo = await getImageInfo(sourcePath)
  const startedAt = Date.now()
  const draft = await createDraft(sourcePath, baselineCase.settings)
  const generationTimeMs = Date.now() - startedAt
  const serializedCells = draft.cells.map(serializeCell)
  const palette = derivePalette(draft.cells)

  return {
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
  }
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
    // 不能用 localeCompare：不同运行环境 locale 不同，paletteHash 会漂移，基线就失去意义
    .sort(([leftCode], [rightCode]) => (leftCode < rightCode ? -1 : leftCode > rightCode ? 1 : 0))
    .map(([colorCode, color]) => `${colorCode}:${color}`)
}

/**
 * FNV-1a 32 位。注意这里按 **UTF-16 码元** 迭代，不是 UTF-8 字节 —— 输入恒为中文色号与
 * 十六进制色值（纯 ASCII），两者结果一致；真塞进非 ASCII 时才可能漂移。
 *
 * 用它的目的只是「同一份图纸跨机器算出同一个值」，够检出回归即可，别拿它当通用摘要。
 */
function fnv1a32(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function writeBaselineFile(serializedOutput: string): void {
  const userDataPath = wx.env?.USER_DATA_PATH
  // 缺 USER_DATA_PATH 时拼出来的路径是 "undefined/..."，写失败还很费解：这里直接说清楚
  if (!userDataPath) {
    console.warn('[Standard V1 WeChat Canvas Baseline] 当前环境无 USER_DATA_PATH，跳过写入基线文件')
    return
  }
  const outputPath = `${userDataPath}/standard-v1-wechat-canvas-baseline.json`
  try {
    wx.getFileSystemManager().writeFileSync(outputPath, serializedOutput, 'utf8')
    console.info(`[Standard V1 WeChat Canvas Baseline] 已写入 ${outputPath}`)
  } catch (error) {
    console.warn('[Standard V1 WeChat Canvas Baseline] 写入基线文件失败', error)
  }
}
