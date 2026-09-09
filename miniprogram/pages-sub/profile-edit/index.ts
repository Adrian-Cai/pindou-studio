import { authStore } from '../../store/auth-store'

const DEFAULT_AVATAR_PATH = '/assets/icons/brand-avatar.webp'

interface NicknameInputEvent {
  detail: { value?: string }
}

Page({
  data: {
    profileDraftAvatarPath: DEFAULT_AVATAR_PATH,
    profileDraftNickname: '',
    profileCanSave: false,
    profileSaving: false,
    profileMessage: '',
  },

  onLoad() {
    const user = authStore.getSnapshot().profile?.user ?? authStore.getSnapshot().user
    const nickname = user?.nickname?.trim() || ''
    this.setData({
      profileDraftAvatarPath: DEFAULT_AVATAR_PATH,
      profileDraftNickname: nickname,
      profileCanSave: Boolean(nickname),
      profileSaving: false,
      profileMessage: '',
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
      wx.navigateBack({
        success: () => {
          wx.showToast({ title: '资料已保存', icon: 'success' })
        },
      })
    } catch (error) {
      this.setData({
        profileSaving: false,
        profileMessage: error instanceof Error ? error.message : '保存失败，请稍后重试',
      })
    }
  },
})
