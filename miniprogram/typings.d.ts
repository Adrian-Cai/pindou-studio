interface IAppOption {
  globalData: {
    store: import('./store/app-store').AppStore
    auth: import('./store/auth-store').AuthStore
  }
}
