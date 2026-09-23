/**
 * 小程序入口：只做启动编排，不含业务逻辑。
 *
 * 职责：初始化云开发 → 恢复本地作品数据 → 恢复登录态 → 启动 AI 任务调度 → 监听网络恢复补同步。
 * 边界：各启动项彼此独立，单项失败只降级该能力，不牵连其他项，更不允许整个 App 起不来。
 * 调用方：微信小程序框架（除 app.json 声明外无显式调用者）。
 * 关键点：onLaunch 里任何同步抛错都会导致启动即崩，真机调试会退化成「Error: Timeout」，
 *         与网络故障的表象完全一致、极难定位，因此每一环都必须各自吞掉异常、只告警。
 */
import { appStore } from './store/app-store'
import { authStore } from './store/auth-store'
import { syncPendingWorks } from './services/work-sync-service'
import { initCloud } from './config/cloud'
import { aiTaskManager } from './services/ai-generation-manager'

/** 执行一项启动初始化：失败只告警不抛出，保证 onLaunch 不被单点异常中断（见文件头「关键点」）。 */
function runStartupSafely(warning: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    console.warn(warning, error)
  }
}

/**
 * 异步版：接住 fire-and-forget 启动项的 Promise 拒绝。
 *
 * `void promise` 不会阻断 onLaunch，但一旦 reject 就是一条未捕获拒绝：
 * 控制台看到的是无堆栈的 "Unhandled promise rejection"，
 * 既掩盖了真实原因，又会在部分基础库上触发全局错误采集。
 * 启动项「失败只降级」的契约要求它们同样走 warn 处理。
 */
function runStartupSafelyAsync(warning: string, run: () => Promise<unknown>): void {
  Promise.resolve()
    .then(run)
    .catch((error) => console.warn(warning, error))
}

App<IAppOption>({
  globalData: {
    store: appStore,
    auth: authStore,
  },
  onLaunch() {
    runStartupSafely('微信云开发初始化失败，生图功能暂不可用', () => initCloud())
    runStartupSafely('本地作品数据恢复失败', () => appStore.hydrate())
    runStartupSafely('AI 任务调度初始化失败', () => aiTaskManager.init())
    runStartupSafelyAsync('登录态恢复失败', () => authStore.restore())
    wx.onNetworkStatusChange(({ isConnected }) => {
      const userId = authStore.getSnapshot().user?.id
      // 网络恢复时的补同步是尽力而为：失败了下次联网还会再试，没必要制造未捕获拒绝
      if (isConnected && userId) runStartupSafelyAsync('补同步失败', () => syncPendingWorks(userId))
    })
  },
  // 小程序切后台后 JS 会被挂起，定时器不可靠：回前台时立刻追赶一次未完成的 AI 任务
  onShow() {
    aiTaskManager.onAppShow()
  },
  onHide() {
    aiTaskManager.onAppHide()
  },
})
