import type { MaterialItem } from '../../utils'

const PALETTE_PREVIEW_LIMIT = 5

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  properties: {
    materials: {
      type: Array,
      value: [] as MaterialItem[],
    },
    downloadLoading: {
      type: Boolean,
      value: false,
    },
    downloadingType: {
      type: String,
      value: '',
    },
  },

  data: {
    expanded: false,
    previewMaterials: [] as MaterialItem[],
  },

  observers: {
    materials(list: MaterialItem[]) {
      this.setData({
        previewMaterials: (list || []).slice(0, PALETTE_PREVIEW_LIMIT),
      })
    },
  },

  methods: {
    togglePalette() {
      this.setData({ expanded: !this.data.expanded })
    },

    handleDownload(event: WechatMiniprogram.CustomEvent) {
      this.triggerEvent('download', event.detail)
    },
  },
})
