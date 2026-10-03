import { isAuthSessionExpired, loadAuthSession } from '../../../services/token-storage'
import { authStore } from '../../../store/auth-store'
import { navigateBackOrHome } from '../../../utils/navigation'

Page({
  data: { isDeleting: false },

  onShow() {
    const session = loadAuthSession()
    if (session && !isAuthSessionExpired(session)) void authStore.refresh()
  },

  openDocument(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key)
    if (key !== 'privacy-policy' && key !== 'personal-information' && key !== 'third-party-sharing') return
    wx.navigateTo({ url: `/packages/account/privacy-document/index?key=${key}` })
  },

  cancelAccount() {
    if (this.data.isDeleting) return
    const session = loadAuthSession()
    if (!session || isAuthSessionExpired(session)) { wx.showToast({ title: '请先登录后再注销账号', icon: 'none' }); return }
    wx.showModal({
      title: '确认注销账号？', content: '注销后账号、云端作品和账号数据将无法恢复，请确认你已了解相关后果', confirmText: '确认注销', confirmColor: '#e5484d',
      success: ({ confirm }) => { if (confirm) void this.performAccountDeletion() },
    })
  },

  async performAccountDeletion() {
    if (this.data.isDeleting) return
    this.setData({ isDeleting: true })
    try { await authStore.deleteAccount(); wx.showToast({ title: '账号已注销', icon: 'success' }); navigateBackOrHome() }
    catch (error) { this.setData({ isDeleting: false }); wx.showToast({ title: error instanceof Error ? error.message : '注销失败，请稍后重试', icon: 'none' }) }
  },
})
