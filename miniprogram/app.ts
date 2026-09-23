import { appStore } from './store/app-store'
import { authStore } from './store/auth-store'
import { syncPendingWorks } from './services/work-sync-service'
import { initCloud } from './config/cloud'
import { aiTaskManager } from './services/ai-generation-manager'

App<IAppOption>({
  globalData: {
    store: appStore,
    auth: authStore,
  },
  onLaunch() {
    try {
      initCloud()
    } catch (error) {
      console.warn('微信云开发初始化失败，生图功能暂不可用', error)
    }
    appStore.hydrate()
    void authStore.restore()
    aiTaskManager.init()
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
