import { runWechatCanvasBaseline } from './wechat-canvas-runner'
import { generatePhase3PatternCells } from './standard-generator-phase-3'
import type { WechatCanvasOutput } from './wechat-canvas-runner'

export function runWechatCanvasPhase3(): Promise<WechatCanvasOutput> {
  return runWechatCanvasBaseline(3, async (sourcePath, settings) => ({
    settings,
    cells: await generatePhase3PatternCells(sourcePath, settings),
  }))
}
