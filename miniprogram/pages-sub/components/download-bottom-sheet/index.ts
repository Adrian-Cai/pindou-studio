Component({
  properties: {
    visible: {
      type: Boolean,
      value: false,
    },
    state: {
      type: String,
      value: 'closed',
    },
    config: {
      type: Object,
      value: {},
    },
    quota: {
      type: Number,
      value: 0,
    },
    isVip: {
      type: Boolean,
      value: false,
    },
    costText: {
      type: String,
      value: '1 次下载次数',
    },
  },

  methods: {
    onTapMask() {
      if (this.data.state === 'processing') return
      this.triggerEvent('close')
    },

    onConfirm() {
      if (this.data.state === 'processing') return
      this.triggerEvent('confirm')
    },

    onCancel() {
      if (this.data.state === 'processing') return
      this.triggerEvent('cancel')
    },

    onPreview() {
      this.triggerEvent('preview')
    },

    onComplete() {
      this.triggerEvent('complete')
    },

    preventTouchMove() {
      // 阻止蒙层下滚动穿透
    },
  },
})
