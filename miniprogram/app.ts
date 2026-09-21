import { appStore } from './store/app-store'
import { authStore } from './store/auth-store'
import { syncPendingWorks } from './services/work-sync-service'
import { initCloud } from './config/cloud'

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
    wx.onNetworkStatusChange(({ isConnected }) => {
      const userId = authStore.getSnapshot().user?.id
      if (isConnected && userId) void syncPendingWorks(userId)
    })
  },
})
