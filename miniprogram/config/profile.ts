export const PROFILE_MENU_ITEMS = [
  { id: 'downloads', icon: '/assets/icons/profile-menu-download.svg', title: '下载记录', url: '/pages/downloads/index' },
  { id: 'help', icon: '/assets/icons/profile-menu-help.svg', title: '使用帮助', url: '/pages/help/index' },
  { id: 'feedback', icon: '/assets/icons/profile-menu-feedback.svg', title: '意见反馈', url: '/pages/feedback/index' },
  { id: 'privacy', icon: '/assets/icons/profile-menu-shield.svg', title: '隐私设置', url: '/pages/privacy/index' },
  { id: 'about', icon: '/assets/icons/profile-menu-info.svg', title: '关于我们', url: '/pages/about/index' },
] as const

export const HELP_QUESTIONS = [
  {
    title: '如何上传图片生成拼豆图？',
    answer: '在首页点击“上传图片”按钮，选择 JPG、PNG 或 WEBP 格式的图片，系统会自动处理并生成拼豆图像。建议使用清晰、光线充足的图片。',
  },
  {
    title: '怎么下载施工图？',
    answer: '作品生成后进入作品结果页，切换到“施工图”，点击下载按钮即可保存。实际保存能力将在文件导出服务接入后开放。',
  },
  {
    title: '下载次数如何计算？',
    answer: '每次保存一份新的完整图纸消耗一次下载次数，同一份图纸重复下载不重复扣除。',
  },
  {
    title: '为什么生成较慢？',
    answer: '大尺寸图片和较多颜色需要更多处理时间。弱网络环境下请保持页面打开，处理失败时可重新尝试。',
  },
  {
    title: '如何联系人工支持？',
    answer: '可在意见反馈页面描述问题并留下联系方式，客服会在工作时间内尽快处理。',
  },
] as const

export const FEEDBACK_CATEGORIES = [
  { id: 'feature', symbol: '◇', label: '功能建议' },
  { id: 'bug', symbol: '※', label: '问题反馈' },
  { id: 'payment', symbol: '▣', label: '支付问题' },
  { id: 'experience', symbol: '○', label: '体验吐槽' },
] as const

export const DOWNLOAD_PACKAGES = [
  { id: 'starter', count: 3, price: '9.9', label: '加购 3 次' },
  { id: 'value', count: 10, price: '19.9', label: '加购 10 次' },
  { id: 'unlimited', count: 0, price: '29.9', label: '无限下载会员（月）' },
] as const
