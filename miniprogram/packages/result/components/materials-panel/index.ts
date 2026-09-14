import type { MaterialItem } from '../../utils'

const MATERIAL_PREVIEW_LIMIT = 5

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  properties: {
    materials: {
      type: Array,
      value: [] as MaterialItem[],
    },
    brand: {
      type: String,
      value: 'MARD',
    },
    beadCount: {
      type: Number,
      value: 0,
    },
    colorCount: {
      type: Number,
      value: 0,
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
    visibleMaterials: [] as MaterialItem[],
  },

  observers: {
    'materials, expanded'(materials: MaterialItem[], expanded: boolean) {
      const list = materials || []
      this.setData({
        visibleMaterials: expanded ? list : list.slice(0, MATERIAL_PREVIEW_LIMIT),
      })
    },
  },

  methods: {
    toggleMaterialList() {
      this.setData({ expanded: !this.data.expanded })
    },

    handleDownload(event: WechatMiniprogram.CustomEvent) {
      this.triggerEvent('download', event.detail)
    },
  },
})
