type UploadStatus = 'empty' | 'uploading' | 'checking' | 'success' | 'rejected' | 'error'

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

  methods: {
    handleChooseImage() {
      this.triggerEvent('chooseimage')
    },

    handlePreviewError() {
      this.triggerEvent('previewerror')
    },
  },
})
