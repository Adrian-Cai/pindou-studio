import { getCustomNavigationMetrics, navigateBackOrHome } from '../../utils/navigation'

Component({
  properties: {
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    back: { type: Boolean, value: false },
    actionText: { type: String, value: '' },
    actionType: { type: String, value: 'text' },
    home: { type: Boolean, value: false },
    backInsetRpx: { type: Number, value: 32 },
    navigationBarHeight: {
      type: Number,
      value: 0,
      observer(value: number) {
        if (value > 0) this.setData({ resolvedNavigationBarHeight: value })
      },
    },
  },
  data: {
    statusBarHeight: 20,
    menuButtonReserve: 16,
    resolvedNavigationBarHeight: 0,
  },
  lifetimes: {
    attached() {
      const metrics = getCustomNavigationMetrics()
      this.setData({
        statusBarHeight: metrics.statusBarHeight,
        menuButtonReserve: metrics.menuButtonReserve,
        resolvedNavigationBarHeight:
          this.properties.navigationBarHeight > 0
            ? this.properties.navigationBarHeight
            : metrics.navigationBarHeight,
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
