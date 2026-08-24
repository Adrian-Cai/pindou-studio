import { navigateBackOrHome } from '../../utils/navigation'

Component({
  properties: {
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    back: { type: Boolean, value: false },
    actionText: { type: String, value: '' },
    home: { type: Boolean, value: false },
  },
  data: {
    statusBarHeight: 20,
  },
  lifetimes: {
    attached() {
      this.setData({ statusBarHeight: wx.getWindowInfo().statusBarHeight })
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
