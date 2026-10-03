import { ApiError, apiRequest } from '../../../services/http-client'

export type LegalDocumentKey = 'paid-service' | 'user-agreement' | 'privacy-policy' | 'personal-information' | 'third-party-sharing'

export interface LegalDocument {
  key: LegalDocumentKey
  title: string
  version: string
  effectiveAt: string
  contentType: 'rich-text'
  content: string
}

const STORAGE_PREFIX = 'pindou:legal-doc:'
const memoryCache = new Map<LegalDocumentKey, LegalDocument>()

export function getCachedLegalDocument(key: LegalDocumentKey): LegalDocument | null {
  const memory = memoryCache.get(key)
  if (memory?.key === key) return memory

  try {
    const raw = wx.getStorageSync(`${STORAGE_PREFIX}${key}`)
    if (raw) {
      const doc = parseDocument(raw)
      if (doc?.key === key) {
        memoryCache.set(key, doc)
        return doc
      }
    }
  } catch {
    // 忽略存储读取异常
  }
  return null
}

export function saveCachedLegalDocument(document: LegalDocument): void {
  memoryCache.set(document.key, document)
  try {
    wx.setStorageSync(`${STORAGE_PREFIX}${document.key}`, document)
  } catch {
    // 忽略存储写入异常
  }
}

export async function fetchLegalDocument(key: LegalDocumentKey): Promise<LegalDocument> {
  const response = await apiRequest<unknown>({
    path: `/api/legal-documents/${key}`,
  })
  const document = isRecord(response) ? parseDocument(response.document) : null
  if (!document || document.key !== key) {
    throw new ApiError('服务返回了无法识别的文档内容，请稍后重试', { code: 'INVALID_RESPONSE' })
  }
  saveCachedLegalDocument(document)
  return document
}

function parseDocument(value: unknown): LegalDocument | null {
  if (!isRecord(value)) return null
  if (
    !isLegalDocumentKey(value.key)
    || typeof value.title !== 'string'
    || typeof value.version !== 'string'
    || typeof value.effectiveAt !== 'string'
    || value.contentType !== 'rich-text'
    || typeof value.content !== 'string'
  ) return null
  return {
    key: value.key,
    title: value.title,
    version: value.version,
    effectiveAt: value.effectiveAt,
    contentType: 'rich-text',
    content: value.content,
  }
}

function isLegalDocumentKey(value: unknown): value is LegalDocumentKey {
  return value === 'paid-service'
    || value === 'privacy-policy'
    || value === 'user-agreement'
    || value === 'personal-information'
    || value === 'third-party-sharing'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
