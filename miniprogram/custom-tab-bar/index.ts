const items = [
  {
    pagePath: '/pages/home/index',
    text: '首页',
    icon: '/assets/icons/home.svg',
    activeIcon: '/assets/icons/home-active.svg',
  },
  {
    pagePath: '/pages/projects/index',
    text: '作品',
    icon: '/assets/icons/projects.svg',
    activeIcon: '/assets/icons/projects-active.svg',
  },
  {
    pagePath: '/pages/profile/index',
    text: '我的',
    icon: '/assets/icons/profile.svg',
    activeIcon: '/assets/icons/profile-active.svg',
  },
]

Component({
  data: {
    items,
    selected: 0,
  },
  pageLifetimes: {
    show() {
      const pages = getCurrentPages()
      const route = '/' + (pages[pages.length - 1]?.route ?? '')
      const selected = items.findIndex((item) => item.pagePath === route)
      this.setData({ selected: Math.max(0, selected) })
    },
  },
  methods: {
    switchTab(event: WechatMiniprogram.TouchEvent) {
      const index = Number(event.currentTarget.dataset.index)
      wx.switchTab({ url: items[index].pagePath })
    },
  },
})
