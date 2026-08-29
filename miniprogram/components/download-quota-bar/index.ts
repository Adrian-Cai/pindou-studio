Component({
  properties: {
    quota: {
      type: Number,
      value: 0,
    },
    tipsOpen: {
      type: Boolean,
      value: false,
    },
  },

  methods: {
    toggleTips() {
      this.triggerEvent('toggletips')
    },

    closeTips() {
      this.triggerEvent('closetips')
    },

    openMembership() {
      this.triggerEvent('openmembership')
    },

    keepTipsOpen() {},
  },
})
