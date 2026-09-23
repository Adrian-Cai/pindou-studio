import { normalizeAvatarUrl } from '../../config/api'
import { DAILY_FREE_DOWNLOAD_QUOTA, appStore } from '../../store/app-store'
import { authStore } from '../../store/auth-store'
import {
  fetchAiGenerationPackages,
  createPaymentIdempotencyKey,
  isWechatPaymentCancelled,
  payForAiGenerationPackage,
  paymentErrorMessage,
  type AiGenerationPackage,
} from '../../services/payment-service'

const DEFAULT_AVATAR_PATH = '/assets/icons/brand-avatar.webp'

type ProfileSheet = 'none' | 'recharge' | 'login' | 'profile'
type LoginUiState = 'idle' | 'loading' | 'error'
type LoginMessageTone = 'info' | 'error'
type AuthState = ReturnType<typeof authStore.getSnapshot>

interface NicknameInputEvent {
  detail: { value?: string }
}

Page({
  data: {
    packages: [] as AiGenerationPackage[],
    packagesLoading: false,
    packageMessage: '',
    downloadQuota: 0,
    dailyFreeDownloadQuota: DAILY_FREE_DOWNLOAD_QUOTA,
    aiGenerationQuota: 0,
    dailyFreeAiGenerationQuota: 0,
    aiGenerationDailyFreeRemaining: 0,
    aiGenerationPurchasedQuota: 0,
    aiQuotaTipsOpen: false,
    avatarPath: DEFAULT_AVATAR_PATH,
    isLoggedIn: false,
    accountName: '拼豆用户',
    activeSheet: 'none' as ProfileSheet,
    loginUiState: 'idle' as LoginUiState,
    loginAgreementAccepted: false,
    loginClosing: false,
    loginMessage: '',
    loginMessageTone: 'info' as LoginMessageTone,
    profileDraftAvatarPath: DEFAULT_AVATAR_PATH,
    profileDraftNickname: '',
    profileCanSave: false,
    profileSaving: false,
    profileMessage: '',
    selectedPackage: 0,
    selectedPackagePrice: '',
    paymentLoading: false,
    /** 本次购买的幂等键：支付成功/明确取消前一直复用，避免重复下单。 */
    paymentIdempotencyKey: '',
  },

  authUnsubscribe: undefined as (() => void) | undefined,
  appUnsubscribe: undefined as (() => void) | undefined,
  loginCloseTimer: 0,
  preserveSheetOnNextHide: false,

  onLoad() {
    this.authUnsubscribe = authStore.subscribe((state) => this.applyAuthState(state))
    this.appUnsubscribe = appStore.subscribe(() => this.applyAuthState(authStore.getSnapshot()))
  },

  onShow() {
    this.getTabBar()?.setData({
      selected: 2,
      hidden: this.data.activeSheet !== 'none',
    })
    if (this.data.activeSheet !== 'none') {
      wx.hideTabBar({ animation: false })
    }
    this.applyAuthState(authStore.getSnapshot())
    if (this.data.isLoggedIn) {
      void authStore.refresh()
    } else {
      void authStore.refreshQuota()
    }
  },

  onUnload() {
    clearTimeout(this.loginCloseTimer)
    this.authUnsubscribe?.()
    this.authUnsubscribe = undefined
    this.appUnsubscribe?.()
    this.appUnsubscribe = undefined
  },

  applyAuthState(authState: Readonly<AuthState>) {
    const state = appStore.getSnapshot()
    const profile = authState.profile
    const user = profile?.user ?? authState.user
    const hasAuthenticatedUser = Boolean(user) && (
      authState.status === 'authenticated'
      || authState.status === 'refreshing'
      || authState.status === 'restoring'
      || authState.status === 'updating'
    )
    const completedLogin = hasAuthenticatedUser && this.data.activeSheet === 'login'
    const profileComplete = Boolean(user?.nickname?.trim())
    const shouldCompleteProfile = completedLogin && !profileComplete
    const nextSheet = completedLogin
      ? shouldCompleteProfile ? 'profile' : 'none'
      : this.data.activeSheet

    const downloadQuota = profile?.quota.remaining ?? state.downloadQuota
    const dailyFreeDownloadQuota = profile?.quota.dailyFree ?? DAILY_FREE_DOWNLOAD_QUOTA
    const aiGenerationQuota = profile?.quota.aiGeneration.remaining ?? 0
    const aiGenerationDailyFreeQuota = profile?.quota.aiGeneration.dailyFree ?? 0
    const aiGenerationDailyFreeRemaining = Math.max(
      0,
      aiGenerationDailyFreeQuota - (profile?.quota.aiGeneration.usedToday ?? 0),
    )
    const aiGenerationPurchasedQuota = profile?.quota.aiGeneration.purchased ?? 0

    this.setData({
      downloadQuota,
      dailyFreeDownloadQuota,
      aiGenerationQuota,
      dailyFreeAiGenerationQuota: aiGenerationDailyFreeQuota,
      aiGenerationDailyFreeRemaining,
      aiGenerationPurchasedQuota,
      avatarPath: normalizeAvatarUrl(user?.avatarUrl) || DEFAULT_AVATAR_PATH,
      isLoggedIn: hasAuthenticatedUser,
      accountName: user?.nickname?.trim() || '拼豆用户',
      loginUiState: authState.status === 'authenticating'
        ? 'loading'
        : authState.status === 'error' ? 'error' : 'idle',
      loginMessage: authState.status === 'error' ? authState.errorMessage : '',
      loginMessageTone: 'error',
      activeSheet: nextSheet,
      ...(shouldCompleteProfile ? {
        profileDraftAvatarPath: DEFAULT_AVATAR_PATH,
        profileDraftNickname: user?.nickname?.trim() || '',
        profileCanSave: Boolean(user?.nickname?.trim()),
        profileMessage: '',
      } : {}),
    })

    if (completedLogin) {
      if (!shouldCompleteProfile) this.restoreTabBar()
      wx.showToast({
        title: authState.isOffline
          ? '已登录，等待网络恢复'
          : shouldCompleteProfile ? '登录成功，请完善资料' : '登录成功',
        icon: 'none',
      })
    }

    if (authState.status === 'expired') {
      if (this.data.activeSheet !== 'none') {
        this.setData({ activeSheet: 'none' })
        this.restoreTabBar()
      }
      wx.showToast({ title: '登录状态已过期，请重新登录', icon: 'none' })
      authStore.acknowledgeExpiry()
    }
  },

  openProjects() {
    wx.switchTab({ url: '/pages/projects/index' })
  },

  openFavorites() {
    wx.navigateTo({ url: '/packages/account/favorites/index' })
  },

  openDownloads() {
    wx.navigateTo({ url: '/packages/download/index' })
  },

  openOrders() {
    wx.navigateTo({ url: '/packages/payment/orders/index' })
  },

  openSettings() {
    wx.navigateTo({ url: '/packages/account/settings/index' })
  },

  openUserPanel() {
    if (this.data.isLoggedIn) {
      wx.navigateTo({ url: '/packages/account/index' })
      return
    }
    authStore.clearError()
    this.showProfileSheet('login')
  },

  showProfileSheet(sheet: Exclude<ProfileSheet, 'none'>) {
    clearTimeout(this.loginCloseTimer)
    wx.hideTabBar({ animation: false })
    this.getTabBar()?.setData({ hidden: true })
    this.setData({
      activeSheet: sheet,
      paymentLoading: false,
      loginClosing: false,
      loginAgreementAccepted: sheet === 'login' ? false : this.data.loginAgreementAccepted,
      loginUiState: sheet === 'login' ? 'idle' : this.data.loginUiState,
      loginMessage: sheet === 'login' ? '' : this.data.loginMessage,
    })
  },

  showRechargeSheet() {
    this.showProfileSheet('recharge')
    void this.refreshPackages()
  },

  toggleAiQuotaTips() {
    this.setData({ aiQuotaTipsOpen: !this.data.aiQuotaTipsOpen })
  },

  closeAiQuotaTips() {
    this.setData({ aiQuotaTipsOpen: false })
  },

  keepAiQuotaTipsOpen() {},

  async refreshPackages() {
    this.setData({ packagesLoading: true, packageMessage: '', selectedPackagePrice: '' })
    try {
      const packages = await fetchAiGenerationPackages()
      this.setData({
        packages,
        packagesLoading: false,
        packageMessage: packages.length > 0 ? '' : '暂无可购买的 AI 生成套餐',
        selectedPackage: 0,
        selectedPackagePrice: packages[0]?.price ?? '',
      })
    } catch {
      this.setData({
        packages: [],
        packagesLoading: false,
        packageMessage: '套餐加载失败，请稍后重试',
        selectedPackagePrice: '',
      })
    }
  },

  openProfileEditor() {
    const user = authStore.getSnapshot().profile?.user ?? authStore.getSnapshot().user
    this.setData({
      profileDraftAvatarPath: normalizeAvatarUrl(user?.avatarUrl) || DEFAULT_AVATAR_PATH,
      profileDraftNickname: user?.nickname?.trim() || '',
      profileCanSave: Boolean(user?.nickname?.trim()),
      profileSaving: false,
      profileMessage: '',
    })
    this.showProfileSheet('profile')
  },

  hideActiveSheet() {
    if (this.data.paymentLoading) return
    clearTimeout(this.loginCloseTimer)
    this.setData({
      activeSheet: 'none',
      paymentLoading: false,
      loginClosing: false,
      loginUiState: 'idle',
      loginMessage: '',
      profileSaving: false,
      profileMessage: '',
    })
    this.restoreTabBar()
  },

  onHide() {
    clearTimeout(this.loginCloseTimer)
    if (this.preserveSheetOnNextHide) {
      this.preserveSheetOnNextHide = false
      return
    }
    if (this.data.activeSheet !== 'none') {
      this.setData({
        activeSheet: 'none',
        loginUiState: 'idle',
        loginMessage: '',
      })
      this.restoreTabBar()
    }
  },

  restoreTabBar() {
    this.getTabBar()?.setData({ hidden: false })
    wx.showTabBar({ animation: false })
  },

  stopPropagation() {},

  selectPackage(event: WechatMiniprogram.TouchEvent) {
    const selectedPackage = Number(event.currentTarget.dataset.index)
    this.setData({
      selectedPackage,
      selectedPackagePrice: this.data.packages[selectedPackage]?.price ?? '',
    })
  },

  async purchase() {
    const selectedPackage = this.data.packages[this.data.selectedPackage]
    if (!selectedPackage || this.data.paymentLoading) return

    // 幂等键绑定「这一次购买意图」：同一份 key 要伴随整段流程（含失败重试），
    // 每次现造一个会让服务端去重形同虚设，重复下单就是重复扣款。
    const idempotencyKey = this.data.paymentIdempotencyKey || createPaymentIdempotencyKey()
    this.setData({ paymentLoading: true, paymentIdempotencyKey: idempotencyKey })
    try {
      const created = await payForAiGenerationPackage(selectedPackage.id, idempotencyKey)
      this.setData({ paymentLoading: false, paymentIdempotencyKey: '' })
      this.hideActiveSheet()
      wx.navigateTo({
        url: `/packages/payment/payment-success/index?orderId=${encodeURIComponent(created.orderId)}`,
      })
    } catch (error) {
      if (isWechatPaymentCancelled(error)) {
        // 用户主动取消：这笔意图结束了，键必须清掉，下次点击是一笔新的购买
        this.setData({ paymentIdempotencyKey: '' })
        wx.showToast({ title: '已取消支付', icon: 'none' })
      } else {
        // 其余失败保留同一个键，让用户「再试一次」仍然走同一笔，不会被重复扣款
        wx.showModal({
          title: '支付未完成',
          content: paymentErrorMessage(error),
          showCancel: false,
        })
      }
    } finally {
      if (this.data.paymentLoading) this.setData({ paymentLoading: false })
    }
  },

  async startWechatLogin() {
    if (this.data.loginUiState === 'loading' || this.data.loginClosing) return
    if (!this.data.loginAgreementAccepted) {
      wx.showToast({ title: '请先阅读并同意用户协议和隐私政策', icon: 'none' })
      return
    }
    this.setData({ loginUiState: 'loading', loginMessage: '' })
    await authStore.login()
  },

  toggleLoginAgreement() {
    if (this.data.loginUiState === 'loading' || this.data.loginClosing) return
    this.setData({ loginAgreementAccepted: !this.data.loginAgreementAccepted })
  },

  closeLoginSheet() {
    if (this.data.loginClosing) return
    this.setData({ loginClosing: true })
    this.loginCloseTimer = setTimeout(() => {
      if (this.data.activeSheet === 'login') this.hideActiveSheet()
    }, 280)
  },

  openUserAgreement() {
    this.openLegalDocument('user-agreement')
  },

  openPrivacyPolicy() {
    this.openLegalDocument('privacy-policy')
  },

  openLegalDocument(key: 'user-agreement' | 'privacy-policy') {
    this.preserveSheetOnNextHide = true
    wx.navigateTo({
      url: `/packages/account/privacy-document/index?key=${key}`,
      fail: () => {
        this.preserveSheetOnNextHide = false
      },
    })
  },

  updateProfileNickname(event: NicknameInputEvent) {
    const nickname = event.detail.value ?? ''
    this.setData({
      profileDraftNickname: nickname,
      profileCanSave: Boolean(nickname.trim()),
      profileMessage: '',
    })
  },

  async saveProfile() {
    if (this.data.profileSaving || !this.data.profileCanSave) return
    const nickname = this.data.profileDraftNickname.trim()
    const length = Array.from(nickname).length
    if (length < 1 || length > 80) {
      this.setData({ profileMessage: '昵称长度需要在 1 到 80 个字符之间' })
      return
    }

    this.setData({ profileSaving: true, profileMessage: '' })
    try {
      await authStore.saveProfile(nickname)
      this.hideActiveSheet()
      wx.showToast({ title: '个人资料已保存', icon: 'success' })
    } catch (error) {
      this.setData({
        profileSaving: false,
        profileMessage: error instanceof Error ? error.message : '个人资料保存失败，请稍后重试',
      })
    }
  },
})
