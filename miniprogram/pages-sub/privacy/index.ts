import type { PrivacyPreferences } from '../../models/pattern'
import { syncLocalWorksToCloud } from '../services/local-work-sync'
import { isAuthSessionExpired, loadAuthSession } from '../../services/token-storage'
import { appStore } from '../../store/app-store'
import { authStore } from '../../store/auth-store'
import { navigateBackOrHome } from '../../utils/navigation'

type PreferenceKey = Exclude<keyof PrivacyPreferences, 'updatedAt'>

Page({
  data: {
    preferences: appStore.getSnapshot().privacyPreferences,
    savingKey: '' as PreferenceKey | '',
    isDeleting: false,
  },

  appUnsubscribe: undefined as (() => void) | undefined,

  onLoad() {
    this.appUnsubscribe = appStore.subscribe((state) => {
      if (!this.data.savingKey) this.setData({ preferences: state.privacyPreferences })
    })
  },

  onShow() {
    this.setData({ preferences: appStore.getSnapshot().privacyPreferences })
    const session = loadAuthSession()
    if (session && !isAuthSessionExpired(session)) void authStore.refresh()
  },

  onUnload() {
    this.appUnsubscribe?.()
    this.appUnsubscribe = undefined
  },

  async changePreference(event: WechatMiniprogram.SwitchChange) {
    if (this.data.savingKey || this.data.isDeleting) {
      this.resetPreferences()
      return
    }

    const key = String(event.currentTarget.dataset.key) as PreferenceKey
    const value = Boolean(event.detail.value)
    const previous = { ...appStore.getSnapshot().privacyPreferences }
    const session = loadAuthSession()
    const canUseRemote = Boolean(session && !isAuthSessionExpired(session) && !authStore.getSnapshot().isOffline)

    if (key === 'cloudSync' && value) {
      if (!canUseRemote) {
        wx.showToast({ title: '请登录并连接网络后开启云同步', icon: 'none' })
        this.resetPreferences()
        return
      }
      if (!await this.confirmCloudSync()) {
        this.resetPreferences()
        return
      }
    }

    if (!canUseRemote) {
      appStore.setPrivacyPreferences({ [key]: value })
      this.resetPreferences()
      wx.showToast({ title: '已保存到本机，本次修改尚未同步', icon: 'none' })
      return
    }

    this.setData({ savingKey: key })
    try {
      await authStore.updatePrivacyPreferences({ [key]: value })
      if (key === 'cloudSync' && value) {
        const syncResult = await syncLocalWorksToCloud()
        wx.showToast({
          title: syncResult.uploaded ? `已开启并同步 ${syncResult.uploaded} 个作品` : '云同步已开启',
          icon: 'success',
        })
      } else {
        wx.showToast({ title: '隐私偏好已更新', icon: 'success' })
      }
    } catch (error) {
      appStore.setPrivacyPreferences(previous)
      wx.showToast({
        title: error instanceof Error ? error.message : '保存失败，请稍后重试',
        icon: 'none',
      })
    } finally {
      this.setData({ savingKey: '', preferences: appStore.getSnapshot().privacyPreferences })
    }
  },

  resetPreferences() {
    this.setData({ preferences: appStore.getSnapshot().privacyPreferences, savingKey: '' })
  },

  confirmCloudSync(): Promise<boolean> {
    return new Promise((resolve) => {
      wx.showModal({
        title: '开启云同步',
        content: '开启后，新保存的作品会同步到云端。是否同时上传当前设备上的本地作品？',
        confirmText: '开启并同步',
        success: ({ confirm }) => resolve(confirm),
        fail: () => resolve(false),
      })
    })
  },

  openDocument(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key)
    if (key !== 'privacy-policy' && key !== 'personal-information' && key !== 'third-party-sharing') return
    wx.navigateTo({
      url: `/pages-sub/privacy-document/index?key=${key}`,
    })
  },

  cancelAccount() {
    if (this.data.isDeleting) return
    const session = loadAuthSession()
    if (!session || isAuthSessionExpired(session)) {
      wx.showToast({ title: '请先登录后再注销账号', icon: 'none' })
      return
    }
    wx.showModal({
      title: '确认注销账号？',
      content: '注销后账号、云端作品和账号数据将无法恢复，请确认你已了解相关后果。',
      confirmText: '确认注销',
      confirmColor: '#e5484d',
      success: ({ confirm }) => {
        if (confirm) void this.performAccountDeletion()
      },
    })
  },

  async performAccountDeletion() {
    if (this.data.isDeleting) return
    this.setData({ isDeleting: true })
    try {
      await authStore.deleteAccount()
      wx.showToast({ title: '账号已注销', icon: 'success' })
      navigateBackOrHome()
    } catch (error) {
      this.setData({ isDeleting: false })
      wx.showToast({
        title: error instanceof Error ? error.message : '注销失败，请稍后重试',
        icon: 'none',
      })
    }
  },
})
