import { HELP_QUESTIONS } from '../../config/profile'

Page({
  data: {
    query: '',
    questions: [...HELP_QUESTIONS],
    openIndex: 0,
  },

  changeSearch(event: WechatMiniprogram.Input) {
    const query = event.detail.value
    const normalized = query.trim().toLowerCase()
    const questions = normalized
      ? HELP_QUESTIONS.filter((item) => `${item.title}${item.answer}`.toLowerCase().includes(normalized))
      : [...HELP_QUESTIONS]
    this.setData({ query, questions, openIndex: questions.length ? 0 : -1 })
  },

  toggleQuestion(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index)
    this.setData({ openIndex: this.data.openIndex === index ? -1 : index })
  },

  openQuickHelp(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    if (id === 'feedback') {
      wx.navigateTo({ url: '/pages/feedback/index' })
      return
    }
    const messages: Record<string, string> = {
      beginner: '从首页上传图片，设置尺寸与颜色后即可开始制作。',
      download: '下载功能将在文件导出服务接入后开放。',
      payment: '支付能力尚未接入，当前不会产生任何费用。',
      support: '请通过意见反馈留下问题与联系方式。',
    }
    wx.showModal({ title: '帮助说明', content: messages[id] ?? '', showCancel: false })
  },
})
