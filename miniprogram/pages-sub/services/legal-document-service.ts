import { ApiError, apiRequest } from '../../services/http-client'

export type LegalDocumentKey = 'user-agreement' | 'privacy-policy' | 'personal-information' | 'third-party-sharing'

export interface LegalDocument {
  key: LegalDocumentKey
  title: string
  version: string
  effectiveAt: string
  contentType: 'rich-text'
  content: string
}

export async function fetchLegalDocument(key: LegalDocumentKey): Promise<LegalDocument> {
  const response = await apiRequest<unknown>({
    path: `/api/legal-documents/${key}`,
  })
  const document = isRecord(response) ? parseDocument(response.document) : null
  if (!document) {
    throw new ApiError('服务返回了无法识别的文档内容，请稍后重试', { code: 'INVALID_RESPONSE' })
  }
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
  return value === 'privacy-policy'
    || value === 'user-agreement'
    || value === 'personal-information'
    || value === 'third-party-sharing'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
