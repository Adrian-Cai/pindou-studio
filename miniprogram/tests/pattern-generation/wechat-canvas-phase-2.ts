import { runWechatCanvasBaseline } from './wechat-canvas-runner'
import type { WechatCanvasOutput } from './wechat-canvas-runner'

export function runWechatCanvasPhase2(): Promise<WechatCanvasOutput> {
  return runWechatCanvasBaseline(2)
}
