import { fetchLegalDocument, type LegalDocumentKey } from '../../services/legal-document-service'

const TITLES: Record<LegalDocumentKey, string> = {
  'privacy-policy': '隐私政策',
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
      this.setData({ loading: false, errorMessage: '文档地址无效，请返回后重试。' })
      return
    }
    this.setData({ key, title: TITLES[key] })
    void this.loadDocument(key)
  },

  async loadDocument(key: LegalDocumentKey) {
    this.setData({ loading: true, errorMessage: '' })
    try {
      const document = await fetchLegalDocument(key)
      const content = document.content.trim()
      this.setData({
        title: document.title,
        version: document.version,
        effectiveAt: formatDate(document.effectiveAt),
        content: document.content,
        empty: content.length === 0,
        loading: false,
      })
    } catch (error) {
      this.setData({
        loading: false,
        errorMessage: error instanceof Error ? error.message : '文档加载失败，请稍后重试。',
      })
    }
  },

  retry() {
    const key = this.data.key
    if (key) void this.loadDocument(key)
  },
})

function parseKey(value: string | undefined): LegalDocumentKey | null {
  if (value === 'privacy-policy' || value === 'personal-information' || value === 'third-party-sharing') {
    return value
  }
  return null
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
