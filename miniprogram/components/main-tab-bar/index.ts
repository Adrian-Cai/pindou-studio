const items = [
  {
    pagePath: '/pages/home/index',
    text: '首页',
    icon: '/assets/icons/iconsax/home-2.svg',
    activeIcon: '/assets/icons/iconsax/home-2-active.svg',
  },
  {
    pagePath: '/pages/projects/index',
    text: '作品',
    icon: '/assets/icons/iconsax/gallery-muted.svg',
    activeIcon: '/assets/icons/iconsax/gallery.svg',
  },
  {
    pagePath: '/pages/profile/index',
    text: '我的',
    icon: '/assets/icons/iconsax/profile-circle.svg',
    activeIcon: '/assets/icons/iconsax/profile-circle-active.svg',
  },
]

Component({
  properties: {
    selected: { type: Number, value: -1 },
    emitOnly: { type: Boolean, value: false },
  },

  data: {
    items,
    currentSelected: 0,
  },

  observers: {
    selected() {
      this.syncSelected()
    },
  },

  lifetimes: {
    attached() {
      this.syncSelected()
    },
  },

  pageLifetimes: {
    show() {
      this.syncSelected()
    },
  },

  methods: {
    syncSelected() {
      if (this.properties.selected >= 0) {
        this.setData({ currentSelected: this.properties.selected })
        return
      }

      const pages = getCurrentPages()
      const route = '/' + (pages[pages.length - 1]?.route ?? '')
      const currentSelected = items.findIndex((item) => item.pagePath === route)
      this.setData({ currentSelected: Math.max(0, currentSelected) })
    },

    switchTab(event: WechatMiniprogram.TouchEvent) {
      const index = Number(event.currentTarget.dataset.index)
      const item = items[index]
      if (!item || index === this.data.currentSelected) return
      if (this.properties.emitOnly) {
        this.triggerEvent('navigate', { url: item.pagePath })
        return
      }
      wx.switchTab({ url: item.pagePath })
    },
  },
})
