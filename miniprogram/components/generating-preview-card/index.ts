Component({
  options: {
    virtualHost: true,
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
  },
})
