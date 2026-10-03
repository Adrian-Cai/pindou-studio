import {
  fetchLegalDocument,
  getCachedLegalDocument,
  type LegalDocument,
  type LegalDocumentKey,
} from '../services/legal-document-service'

const TITLES: Record<LegalDocumentKey, string> = {
  'paid-service': '小露拼豆付费服务协议',
  'user-agreement': '小露拼豆用户协议',
  'privacy-policy': '小露拼豆隐私政策',
  'personal-information': '个人信息收集清单',
  'third-party-sharing': '第三方信息共享清单',
}

Page({
  data: {
    title: '隐私文档',
    version: '',
    effectiveAt: '',
    content: '',
    loading: true,
    empty: false,
    /** 本次展示来自缓存、联网刷新失败：提示用户内容可能不是最新版本。 */
    stale: false,
    errorMessage: '',
    key: '' as LegalDocumentKey | '',
  },

  onLoad(options: Record<string, string | undefined>) {
    const key = parseKey(options.key)
    if (!key) {
      this.setData({ loading: false, errorMessage: '文档地址无效，请返回后重试' })
      return
    }
    this.setData({ key, title: TITLES[key] })
    void this.loadDocument(key)
  },

  async loadDocument(key: LegalDocumentKey) {
    const cached = getCachedLegalDocument(key)
    if (cached) {
      this.applyDocument(cached)
    } else {
      this.setData({ loading: true, errorMessage: '' })
    }

    try {
      const document = await fetchLegalDocument(key)
      // 变更检测必须覆盖**所有展示字段**：标题和生效日期对法律文本同样重要，
      // 只比 version + content 的话，后端改了标题/生效日却不改版本时，
      // 页面会一直显示旧的标题与日期，而版本号看起来是"最新的"——最误导人的那种不一致。
      if (this.isSameDocument(document)) return
      this.applyDocument(document)
    } catch (error) {
      if (!this.data.content) {
        this.setData({
          loading: false,
          errorMessage: error instanceof Error ? error.message : '文档加载失败，请稍后重试',
        })
        return
      }
      // 已有缓存内容：页面仍可阅读，但必须让用户知道这不是最新的，
      // 否则他会以为看到的是现行条款（法律文档上这个错觉代价很高）
      this.setData({
        loading: false,
        stale: true,
      })
      console.warn('法律文档刷新失败，继续展示缓存版本', error)
    }
  },

  /** 与当前已展示内容逐字段比对，用于判断是否需要重渲染。 */
  isSameDocument(document: LegalDocument): boolean {
    return document.version === this.data.version
      && document.content === this.data.content
      && document.title === this.data.title
      && formatDate(document.effectiveAt) === this.data.effectiveAt
  },

  applyDocument(document: LegalDocument) {
    const content = document.content.trim()
    // 存的是 trimmed 内容：与 empty 判定用同一份来源，
    // 否则「只有空白」的文档会被判 empty 但把原样空白渲染出来，两边自相矛盾
    this.setData({
      title: document.title,
      version: document.version,
      effectiveAt: formatDate(document.effectiveAt),
      content,
      empty: content.length === 0,
      loading: false,
      stale: false,
      errorMessage: '',
    })
  },

  retry() {
    const key = this.data.key
    if (key) void this.loadDocument(key)
  },
})

function parseKey(value: string | undefined): LegalDocumentKey | null {
  if (value === 'paid-service' || value === 'user-agreement' || value === 'privacy-policy' || value === 'personal-information' || value === 'third-party-sharing') {
    return value
  }
  return null
}

function formatDate(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(value)
  return match?.[1] ?? value
}
