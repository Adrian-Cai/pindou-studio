const PROGRESS_BEADS = Array.from({ length: 20 }, (_, index) => ({
  id: index,
  threshold: (index + 1) * 5,
}))

Component({
  options: {
    virtualHost: true,
  },

  data: {
    progressBeads: PROGRESS_BEADS,
  },

  properties: {
    /** 标题 */
    title: {
      type: String,
      value: 'AI 正在生成拼豆图',
    },
    /** 副标题 */
    subtitle: {
      type: String,
      value: '预计还需几分钟，请稍候',
    },
    /** 当前进度 (0 - 100) */
    progress: {
      type: Number,
      value: 60,
    },
    /** 底部提示文本 */
    tipText: {
      type: String,
      value: '正在为你优化图片细节，生成完成后即可开始编辑',
    },
    /** 是否展示底部提示条 */
    showTip: {
      type: Boolean,
      value: true,
    },
    /** 是否在卡片内展示操作按钮（生成中只留「取消生成 / 返回首页」） */
    showActions: {
      type: Boolean,
      value: false,
    },
    /**
     * 失败态：同一张卡片原地切换，去掉进度条与提示胶囊，
     * 左侧按钮变为失败主操作（重新生成 / 购买次数等，触发 retry 事件）。
     */
    failed: {
      type: Boolean,
      value: false,
    },
    /** 失败态主按钮文案，为空时只留「返回首页」 */
    primaryText: {
      type: String,
      value: '重新生成',
    },
    /** 卡片内左侧按钮文案（生成中） */
    cancelText: {
      type: String,
      value: '取消生成',
    },
    /** 卡片内右侧按钮文案 */
    homeText: {
      type: String,
      value: '返回首页',
    },
  },

  methods: {
    /** 左侧主操作：生成中是取消，失败态是重新生成等恢复动作 */
    handlePrimary() {
      this.triggerEvent(this.data.failed ? 'retry' : 'cancel')
    },

    handleHome() {
      this.triggerEvent('backhome')
    },
  },
})
