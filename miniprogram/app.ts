import { appStore } from './store/app-store'
import { authStore } from './store/auth-store'

App<IAppOption>({
  globalData: {
    store: appStore,
    auth: authStore,
  },
  onLaunch() {
    appStore.hydrate()
    void authStore.restore()
  },
})
