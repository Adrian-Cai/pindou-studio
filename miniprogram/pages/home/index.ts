import { copyPageShareLink } from '../../services/share-service'

Page({
  copyShareLink() {
    void copyPageShareLink('home')
  },

  onShareAppMessage() {
    return {
      title: '一起把灵感做成拼豆作品',
      path: '/pages/home/index',
    }
  },
})
