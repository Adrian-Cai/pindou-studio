import { authStore, type AuthState } from '../../store/auth-store'

const DEFAULT_AVATAR_PATH = '/assets/icons/brand-avatar.webp'

Page({
  data: {
    avatarPath: DEFAULT_AVATAR_PATH,
    accountName: '拼豆用户',
    accountRefreshing: false,
  },

  authUnsubscribe: undefined as (() => void) | undefined,

  onLoad() {
    this.authUnsubscribe = authStore.subscribe((state) => this.applyAuthState(state))
  },

  onShow() {
    this.applyAuthState(authStore.getSnapshot())
  },

  onUnload() {
    this.authUnsubscribe?.()
    this.authUnsubscribe = undefined
  },

  applyAuthState(authState: Readonly<AuthState>) {
    const profile = authState.profile
    const user = profile?.user ?? authState.user
    const isLoggedIn = Boolean(user) && (
      authState.status === 'authenticated'
      || authState.status === 'refreshing'
      || authState.status === 'restoring'
      || authState.status === 'updating'
    )

    if (!isLoggedIn) {
      wx.navigateBack({
        fail: () => {
          wx.switchTab({ url: '/pages/profile/index' })
        },
      })
      return
    }

    this.setData({
      accountName: user?.nickname?.trim() || '拼豆用户',
      avatarPath: DEFAULT_AVATAR_PATH,
      accountRefreshing: authState.status === 'refreshing' || authState.status === 'updating',
    })
  },

  openProfileEditor() {
    wx.navigateTo({ url: '/pages-sub/profile-edit/index' })
  },

  async refreshAccountData() {
    if (this.data.accountRefreshing) return
    try {
      await authStore.refresh()
      wx.showToast({ title: '账号数据已同步', icon: 'success' })
    } catch {
      wx.showToast({ title: '刷新失败，请重试', icon: 'none' })
    }
  },

  confirmLogout() {
    wx.showModal({
      title: '确认退出登录？',
      content: '退出后将停止访问云端作品和下载记录，再次登录后可以恢复云端数据',
      confirmText: '退出登录',
      confirmColor: '#E5484D',
      cancelText: '取消',
      cancelColor: '#626573',
      success: ({ confirm }) => {
        if (!confirm) return
        void this.performLogout()
      },
    })
  },

  async performLogout() {
    try {
      await authStore.logout()
      wx.navigateBack({
        success: () => wx.showToast({ title: '已退出登录', icon: 'success' }),
        fail: () => wx.switchTab({ url: '/pages/profile/index' }),
      })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '退出前保存本地数据失败', icon: 'none' })
    }
  },
})
