Component({
  data: {
    selected: 0,
    hidden: false,
  },

  pageLifetimes: {
    show() {
      const pages = getCurrentPages()
      const route = '/' + (pages[pages.length - 1]?.route ?? '')
      const routes = ['/pages/home/index', '/pages/projects/index', '/pages/profile/index']
      this.setData({ selected: Math.max(0, routes.indexOf(route)) })
    },
  },

  methods: {
    switchTab(event: WechatMiniprogram.CustomEvent<{ url: string }>) {
      wx.switchTab({ url: event.detail.url })
    },
  },
})
