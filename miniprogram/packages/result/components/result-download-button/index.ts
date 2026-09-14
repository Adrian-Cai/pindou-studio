Component({
  options: {
    virtualHost: true,
  },

  properties: {
    text: {
      type: String,
      value: '',
    },
    fileType: {
      type: String,
      value: '',
    },
    loading: {
      type: Boolean,
      value: false,
    },
    disabled: {
      type: Boolean,
      value: false,
    },
  },

  methods: {
    requestDownload() {
      if (this.data.loading || this.data.disabled) return
      this.triggerEvent('download', { fileType: this.data.fileType })
    },
  },
})
