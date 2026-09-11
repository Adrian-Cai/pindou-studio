export const PROFILE_MENU_ITEMS = [
  { id: 'downloads', icon: '/assets/icons/iconsax/download.svg', title: '下载记录', url: '/pages-sub/downloads/index' },
  { id: 'help', icon: '/assets/icons/iconsax/message-question.svg', title: '使用帮助', url: '/pages-sub/help/index' },
  { id: 'feedback', icon: '/assets/icons/iconsax/message-text.svg', title: '意见反馈', url: '/pages-sub/feedback/index' },
  { id: 'privacy', icon: '/assets/icons/iconsax/setting-2.svg', title: '隐私设置', url: '/pages-sub/privacy/index' },
  { id: 'about', icon: '/assets/icons/iconsax/info-circle.svg', title: '关于我们', url: '/pages-sub/about/index' },
] as const

export const HELP_QUESTIONS = [
  {
    title: '如何上传图片生成拼豆图？',
    answer: '在首页点击“上传图片”按钮，选择 JPG、PNG 或 WEBP 格式的图片，系统会自动处理并生成拼豆图像建议使用清晰、光线充足的图片',
  },
  {
    title: '怎么下载施工图？',
    answer: '作品生成后进入作品结果页，切换到“施工图”，点击下载按钮即可保存到相册只有保存成功后才会扣除下载次数',
  },
  {
    title: '下载次数如何计算？',
    answer: '成品图、材料清单、施工图和色板参考分别计次；每成功保存一个文件消耗一次，取消、生成失败或保存失败均不扣次数',
  },
  {
    title: '为什么生成较慢？',
    answer: '大尺寸图片和较多颜色需要更多处理时间弱网络环境下请保持页面打开，处理失败时可重新尝试',
  },
  {
    title: '如何联系人工支持？',
    answer: '进入“意见反馈”页面，点击“联系客服”即可打开微信客服会话，直接发送问题描述和截图',
  },
] as const
