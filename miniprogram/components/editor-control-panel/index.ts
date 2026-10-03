interface ControlPanelTool {
  id: string
  label: string
  icon: string
  activeIcon: string
  disabled: boolean
}

/**
 * 工具定义集中在面板组件内，编辑器页与 AI 生成页共用同一套图标与文案，
 * 避免两个页面各维护一份（AI 生成页在分包内，无法复用编辑器分包的服务）。
 */
const TOOL_DEFINITIONS = [
  { id: 'undo', label: '撤销', icon: '/assets/icons/editor-undo.svg', activeIcon: '/assets/icons/editor-undo.svg' },
  { id: 'redo', label: '重做', icon: '/assets/icons/editor-redo.svg', activeIcon: '/assets/icons/editor-redo.svg' },
  { id: 'pencil', label: '画笔', icon: '/assets/icons/editor-pencil.svg', activeIcon: '/assets/icons/editor-pencil-active.svg' },
  { id: 'eyedropper', label: '吸管', icon: '/assets/icons/editor-eyedropper.svg', activeIcon: '/assets/icons/editor-eyedropper-active.svg' },
  { id: 'fill', label: '填充', icon: '/assets/icons/editor-fill.svg', activeIcon: '/assets/icons/editor-fill-active.svg' },
  { id: 'eraser', label: '橡皮擦', icon: '/assets/icons/editor-eraser.svg', activeIcon: '/assets/icons/editor-eraser-active.svg' },
]

/** 调色板占位色块数量：对齐编辑器最多展示的颜色数，保证生成中面板高度不跳动 */
const PALETTE_PLACEHOLDER_COUNT = 16

function buildTools(ready: boolean, undoable: boolean, redoable: boolean): ControlPanelTool[] {
  return TOOL_DEFINITIONS.map((tool) => ({
    ...tool,
    disabled: !ready
      || (tool.id === 'undo' && !undoable)
      || (tool.id === 'redo' && !redoable),
  }))
}

/**
 * 编辑器底部控制面板：缩放、图案信息、工具栏、调色板与底部操作。
 * 编辑器页在图纸就绪后传入 ready 启用交互；AI 生成页在生成中传入 ready=false，
 * 只展示禁用态与任务设置，等生成完成跳转编辑器后再启用。
 */
Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  properties: {
    /** 是否可交互，false 时整个面板置灰不可点 */
    ready: {
      type: Boolean,
      value: false,
    },
    undoable: {
      type: Boolean,
      value: false,
    },
    redoable: {
      type: Boolean,
      value: false,
    },
    activeTool: {
      type: String,
      value: '',
    },
    scalePercent: {
      type: Number,
      value: 100,
    },
    canZoomOut: {
      type: Boolean,
      value: false,
    },
    canZoomIn: {
      type: Boolean,
      value: false,
    },
    width: {
      type: Number,
      value: 0,
    },
    height: {
      type: Number,
      value: 0,
    },
    colorLimit: {
      type: Number,
      value: 0,
    },
    beadCount: {
      type: Number,
      value: 0,
    },
    paletteColors: {
      type: Array,
      value: [] as string[],
    },
    selectedColor: {
      type: String,
      value: '',
    },
    saving: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    tools: buildTools(false, false, false),
    palettePlaceholders: Array.from(
      { length: PALETTE_PLACEHOLDER_COUNT },
      (_, index) => index,
    ),
  },

  observers: {
    'ready, undoable, redoable'(ready: boolean, undoable: boolean, redoable: boolean) {
      this.setData({ tools: buildTools(ready, undoable, redoable) })
    },
  },

  methods: {
    handleZoomOut() {
      if (!this.data.ready || !this.data.canZoomOut) return
      this.triggerEvent('zoomout')
    },

    handleZoomIn() {
      if (!this.data.ready || !this.data.canZoomIn) return
      this.triggerEvent('zoomin')
    },

    handleToolTap(event: WechatMiniprogram.TouchEvent) {
      const toolId = String(event.currentTarget.dataset.tool)
      const tool = this.data.tools.find((item) => item.id === toolId)
      if (!tool || tool.disabled) return
      this.triggerEvent('toolselect', { tool: toolId })
    },

    handleColorTap(event: WechatMiniprogram.TouchEvent) {
      if (!this.data.ready) return
      this.triggerEvent('colorselect', { color: String(event.currentTarget.dataset.color) })
    },

    handleRegenerate() {
      if (!this.data.ready) return
      this.triggerEvent('regenerate')
    },

    handleSave() {
      if (!this.data.ready || this.data.saving) return
      this.triggerEvent('save')
    },
  },
})
