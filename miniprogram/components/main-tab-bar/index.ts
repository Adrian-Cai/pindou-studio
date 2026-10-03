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
    // -1 = 还没算出该高亮哪一项。默认成 0 会让「作品」「我的」页在 attached 之前
    // 先闪一帧高亮在首页上；先不高亮，等 syncSelected 定下来再亮，观感更稳。
    // 下面的 syncSelected 用 Math.max(0, ...) 兜底，渲染侧不会拿到 -1 去取数组。
    currentSelected: -1,
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
