type SecurityStatus = 'idle' | 'checking' | 'passed' | 'rejected' | 'error'

interface PreviewLoadEvent extends WechatMiniprogram.BaseEvent {
  detail: { width: number; height: number }
}

Component({
  options: {
    virtualHost: true,
  },

  properties: {
    sourceImagePath: { type: String, value: '' },
    previewWidth: { type: Number, value: 0 },
    previewHeight: { type: Number, value: 0 },
    choosing: { type: Boolean, value: false },
    securityStatus: { type: String, value: 'idle' as SecurityStatus },
    securityLoadingVisible: { type: Boolean, value: false },
    securityLongWait: { type: Boolean, value: false },
  },

  methods: {
    handleChooseImage() {
      this.triggerEvent('chooseimage')
    },

    handleClearImage() {
      this.triggerEvent('clearimage')
    },

    handlePreviewLoad(event: PreviewLoadEvent) {
      this.triggerEvent('previewload', event.detail)
    },

    handlePreviewError() {
      this.triggerEvent('previewerror')
    },

    handleSecurityHelp() {
      this.triggerEvent('securityhelp')
    },
  },
})
