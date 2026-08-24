import { appStore } from './store/app-store'

App<IAppOption>({
  globalData: {
    store: appStore,
  },
  onLaunch() {
    appStore.hydrate()
  },
})
