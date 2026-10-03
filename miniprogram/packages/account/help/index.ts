import { HELP_QUESTIONS } from '../config/help'

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
    // dataset 缺值时 Number(undefined) 是 NaN，openIndex 会被写坏且此后再也匹配不上任何一项
    const index = Number(event.currentTarget.dataset.index)
    if (!Number.isInteger(index)) return
    this.setData({ openIndex: this.data.openIndex === index ? -1 : index })
  },

  openQuickHelp(event: WechatMiniprogram.TouchEvent) {
    // 同理：缺值时 String(undefined) 得到 'undefined'，会掉进下面的 messages 兜底分支，
    // 弹出一个内容为空的帮助弹窗，比什么都不做更糟
    const id = event.currentTarget.dataset.id
    if (!id) return
    if (id === 'feedback') {
      wx.navigateTo({ url: '/packages/account/feedback/index' })
      return
    }
    const messages: Record<string, string> = {
      beginner: '从首页上传图片，设置尺寸与颜色后即可开始制作',
      download: '下载功能将在文件导出服务接入后开放',
      payment: '选择 AI 生成次数套餐后，通过微信支付完成购买；支付结果可在“我的订单”查看',
      support: '请通过意见反馈留下问题与联系方式',
    }
    wx.showModal({ title: '帮助说明', content: messages[id] ?? '', showCancel: false })
  },
})
