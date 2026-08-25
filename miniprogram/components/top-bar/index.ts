import { getCustomNavigationMetrics, navigateBackOrHome } from '../../utils/navigation'

Component({
  properties: {
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    back: { type: Boolean, value: false },
    actionText: { type: String, value: '' },
    actionType: { type: String, value: 'text' },
    home: { type: Boolean, value: false },
    navigationBarHeight: { type: Number, value: 0 },
  },
  data: {
    statusBarHeight: 20,
    menuButtonReserve: 16,
  },
  lifetimes: {
    attached() {
      const metrics = getCustomNavigationMetrics()
      this.setData({
        statusBarHeight: metrics.statusBarHeight,
        menuButtonReserve: metrics.menuButtonReserve,
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
