import { runWechatCanvasBaseline } from './wechat-canvas-runner'
import type { WechatCanvasOutput } from './wechat-canvas-runner'

export function runWechatCanvasPhase4(): Promise<WechatCanvasOutput> {
  return runWechatCanvasBaseline(4)
}
