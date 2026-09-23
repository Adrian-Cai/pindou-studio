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

App<IAppOption>({
  globalData: {
    store: appStore,
    auth: authStore,
  },
  onLaunch() {
    runStartupSafely('微信云开发初始化失败，生图功能暂不可用', () => initCloud())
    runStartupSafely('本地作品数据恢复失败', () => appStore.hydrate())
    runStartupSafely('AI 任务调度初始化失败', () => aiTaskManager.init())
    void authStore.restore()
    wx.onNetworkStatusChange(({ isConnected }) => {
      const userId = authStore.getSnapshot().user?.id
      if (isConnected && userId) void syncPendingWorks(userId)
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
