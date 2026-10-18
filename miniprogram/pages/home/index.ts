Page({
  onShareAppMessage() {
    return {
      title: '一起把灵感做成拼豆作品',
      path: '/pages/home/index',
      imageUrl: '/assets/samples/share-home.jpg',
    }
  },

  onShareTimeline() {
    return {
      title: '一起把灵感做成拼豆作品',
    }
  },
})
