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
      // version 是后端唯一变更信号，content 兜住漏改版本；两者都没变就不再重渲染
      if (document.version === this.data.version && document.content === this.data.content) return
      this.applyDocument(document)
    } catch (error) {
      if (!this.data.content) {
        this.setData({
          loading: false,
          errorMessage: error instanceof Error ? error.message : '文档加载失败，请稍后重试',
        })
      }
    }
  },

  applyDocument(document: LegalDocument) {
    const content = document.content.trim()
    this.setData({
      title: document.title,
      version: document.version,
      effectiveAt: formatDate(document.effectiveAt),
      content: document.content,
      empty: content.length === 0,
      loading: false,
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
