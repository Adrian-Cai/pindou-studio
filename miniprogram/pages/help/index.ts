const questions = [
  { title: '什么样的图片更适合生成？', answer: '主体清晰、光线均匀、背景简洁的图片效果最好。人物或宠物照片建议先裁剪到主体。' },
  { title: '尺寸和颜色数量怎么选？', answer: '第一次制作建议选择 24 至 32 颗的边长，以及 16 至 24 种颜色，材料更容易准备。' },
  { title: '生成后还能修改颜色吗？', answer: '可以。进入图案编辑器后，可以使用画笔、橡皮和换色工具继续调整。' },
  { title: '下载的文件包含什么？', answer: '整套文件会包含成品图、材料清单、编号施工图和色板参考。' },
]

Page({
  data: {
    questions,
    openIndex: 0,
  },

  toggleQuestion(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index)
    this.setData({ openIndex: this.data.openIndex === index ? -1 : index })
  },
})
