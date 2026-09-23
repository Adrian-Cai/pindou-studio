/**
 * 账户中心页：展示账号信息，并提供资料编辑、数据同步与退出登录。
 *
 * 职责：只做账号态的展示与三个操作入口（编辑资料 / 手动刷新 / 退出登录）；额度与订单由各自页面承载。
 * 调用方：我的（pages/profile）进入，路由 /packages/account/index。
 * 关键点：订阅 authStore，登录态失效时自动退出本页，避免停留在需要登录的界面；
 *         onUnload 必须取消订阅，否则 store 会一直持有已销毁页面的回调；
 *         退出登录前先弹确认框，明确告知会停止访问云端作品。
 */
import { normalizeAvatarUrl } from '../../config/api'
import { authStore, type AuthState } from '../../store/auth-store'

/** 未设置头像时的默认头像。 */
const DEFAULT_AVATAR_PATH = '/assets/icons/brand-avatar.png'

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
      // 服务端下发的是路由相对路径（/api/media/avatars/...），必须补上域名才能给 <image> 用
      avatarPath: normalizeAvatarUrl(user?.avatarUrl) || DEFAULT_AVATAR_PATH,
      accountRefreshing: authState.status === 'refreshing' || authState.status === 'updating',
    })
  },

  openProfileEditor() {
    wx.navigateTo({ url: '/packages/account/profile-edit/index' })
  },

  /** 手动同步账号数据；refreshing 中直接忽略，避免重复请求打断进行中的刷新。 */
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
