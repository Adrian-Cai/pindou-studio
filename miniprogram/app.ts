import { appStore } from './store/app-store'
import { authStore } from './store/auth-store'
import { runWechatCanvasPhase3 } from './tests/pattern-generation/wechat-canvas-phase-3'

App<IAppOption>({
  globalData: {
    store: appStore,
    auth: authStore,
  },
  onLaunch() {
    appStore.hydrate()
    void authStore.restore()

    try {
      if (wx.getAccountInfoSync().miniProgram.envVersion !== 'develop') return
    } catch {
      return
    }

    void runWechatCanvasPhase3().catch((error) => {
      console.error('[Phase 3 Canvas Baseline]', error)
    })
  },
})
