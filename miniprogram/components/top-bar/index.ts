import { navigateBackOrHome } from '../../utils/navigation'

Component({
  properties: {
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    back: { type: Boolean, value: false },
    actionText: { type: String, value: '' },
    actionType: { type: String, value: 'text' },
    home: { type: Boolean, value: false },
  },
  data: {
    statusBarHeight: 20,
    menuButtonReserve: 16,
  },
  lifetimes: {
    attached() {
      const windowInfo = wx.getWindowInfo()
      const menuButton = wx.getMenuButtonBoundingClientRect()
      this.setData({
        statusBarHeight: windowInfo.statusBarHeight,
        menuButtonReserve: Math.max(16, windowInfo.windowWidth - menuButton.left + 8),
      })
    },
  },
  methods: {
    handleBack() {
      navigateBackOrHome()
    },
    handleAction() {
      this.triggerEvent('action')
    },
  },
})
