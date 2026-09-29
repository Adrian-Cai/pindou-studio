import { getCustomNavigationMetrics } from '../../utils/navigation'

Component({
  properties: {
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    back: { type: Boolean, value: false },
    actionText: { type: String, value: '' },
    actionType: { type: String, value: 'text' },
    home: { type: Boolean, value: false },
    showMainNav: { type: Boolean, value: false },
    selectedTab: { type: Number, value: -1 },
    compactBottomPadding: { type: Boolean, value: false },
    scrollIntoView: { type: String, value: '' },
  },

  data: {
    navigationBarHeight: 0,
    scrollAreaHeight: 0,
    contentStyle: '',
    showEmbeddedMainNav: false,
    isMainTabPage: false,
  },

  observers: {
    showMainNav() {
      this.syncEmbeddedMainNav()
    },
  },

  lifetimes: {
    attached() {
      this.updateLayoutMetrics()
      this.syncEmbeddedMainNav()
    },
  },

  pageLifetimes: {
    show() {
      this.syncEmbeddedMainNav()
    },

    resize() {
      this.updateLayoutMetrics()
    },
  },

  methods: {
    updateLayoutMetrics() {
      const metrics = getCustomNavigationMetrics()
      const scrollAreaHeight = Math.max(0, metrics.windowHeight - metrics.topBarHeight)
      this.setData({
        navigationBarHeight: metrics.navigationBarHeight,
        scrollAreaHeight,
        contentStyle: this.properties.home
          ? `height: ${scrollAreaHeight}px;`
          : '',
      })
    },

    syncEmbeddedMainNav() {
      const pages = getCurrentPages()
      const page = pages[pages.length - 1]
      const route = '/' + (page?.route ?? '')
      const isMainTabPage = Boolean(this.properties.home) || ['/pages/home/index', '/pages/projects/index', '/pages/profile/index'].includes(route)
      this.setData({
        showEmbeddedMainNav: this.properties.showMainNav && !isMainTabPage,
        isMainTabPage,
      })
    },

    handleAction() {
      this.triggerEvent('action')
    },
  },
})
