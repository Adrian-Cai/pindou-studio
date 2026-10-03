import { runWechatCanvasBaseline } from './wechat-canvas-runner'
import type { WechatCanvasOutput } from './wechat-canvas-runner'

export function runWechatCanvasPhase5(): Promise<WechatCanvasOutput> {
  return runWechatCanvasBaseline(5)
}
