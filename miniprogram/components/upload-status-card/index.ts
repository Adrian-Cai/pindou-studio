type UploadStatus = 'empty' | 'uploading' | 'checking' | 'success' | 'rejected' | 'error'

const SUCCESS_MESSAGES = [
  { title: '图片检测通过', description: '符合生成要求，可继续使用', icon: '' },
  { title: '主体越清晰，效果越好', description: '人物或宠物轮廓清楚，更容易生成清晰图纸', icon: '/assets/icons/iconsax/info-circle.svg' },
  { title: '简洁背景更适合生成', description: '减少复杂背景，可以让主体更加突出', icon: '/assets/icons/iconsax/info-circle.svg' },
]

const CHECKING_MESSAGES = [
  { title: '正在确认图片内容是否规范', description: '马上就好，请稍等一下', icon: '' },
  { title: '安全检测通过后即可继续', description: '检测完成即可生成拼豆图纸', icon: '' },
]

const messageTimers = new WeakMap<object, ReturnType<typeof setInterval>>()

Component({
  options: {
    virtualHost: true,
  },

  properties: {
    sourceImagePath: { type: String, value: '' },
    choosing: { type: Boolean, value: false },
    uploadStatus: { type: String, value: 'empty' as UploadStatus },
    /** -1 表示 SDK 未提供可展示的真实上传进度 */
    uploadProgress: { type: Number, value: -1 },
  },

  data: {
    carouselMessages: SUCCESS_MESSAGES,
    messageIndex: 0,
    messageCarouselVisible: true,
  },

  observers: {
    'uploadStatus, sourceImagePath'() {
      this.syncMessageCarousel(true)
    },
  },

  lifetimes: {
    attached() {
      this.syncMessageCarousel(true)
    },
    detached() {
      this.clearMessageTimer()
    },
  },

  pageLifetimes: {
    show() {
      this.setData({ messageCarouselVisible: true }, () => this.syncMessageCarousel())
    },
    hide() {
      this.setData({ messageCarouselVisible: false })
      this.clearMessageTimer()
    },
  },

  methods: {
    syncMessageCarousel(reset = false) {
      const status = this.data.uploadStatus
      if ((status !== 'checking' && status !== 'success') || !this.data.sourceImagePath) {
        this.clearMessageTimer()
        if (this.data.messageIndex !== 0 || this.data.carouselMessages !== SUCCESS_MESSAGES) {
          this.setData({ carouselMessages: SUCCESS_MESSAGES, messageIndex: 0 })
        }
        return
      }
      const messages = status === 'checking' ? CHECKING_MESSAGES : SUCCESS_MESSAGES
      if (reset || this.data.carouselMessages !== messages) {
        this.setData({ carouselMessages: messages, messageIndex: 0 })
      }
      if (messageTimers.has(this) || !this.data.messageCarouselVisible) return
      messageTimers.set(this, setInterval(() => {
        this.setData({ messageIndex: (this.data.messageIndex + 1) % this.data.carouselMessages.length })
      }, 3600))
    },

    clearMessageTimer() {
      const timer = messageTimers.get(this)
      if (timer === undefined) return
      clearInterval(timer)
      messageTimers.delete(this)
    },

    handleChooseImage() {
      this.triggerEvent('chooseimage')
    },

    handleRemoveImage() {
      this.triggerEvent('removeimage')
    },

    handlePreviewError() {
      this.triggerEvent('previewerror')
    },
  },
})
