import { ApiError, apiRequest } from './http-client'

export interface AiGenerationPackage {
  id: string
  count: number
  price: string
  label: string
}

export async function fetchAiGenerationPackages(): Promise<AiGenerationPackage[]> {
  const response = await apiRequest<unknown>({ path: '/api/packages' })
  return parsePackages(response)
}

function parsePackages(value: unknown): AiGenerationPackage[] {
  if (!isRecord(value) || !Array.isArray(value.items)) throw invalidResponse()
  return value.items.map(parsePackage)
}

function parsePackage(value: unknown): AiGenerationPackage {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || !value.id
    || typeof value.label !== 'string'
    || !value.label
    || !isPositiveSafeInteger(value.quotaAmount)
    || value.quotaKind !== 'ai_generation'
    || value.membershipType !== null
    || !isPositiveSafeInteger(value.priceFen)
    || value.currency !== 'CNY'
    || value.enabled !== true
  ) throw invalidResponse()

  return {
    id: value.id,
    count: value.quotaAmount,
    price: formatPrice(value.priceFen),
    label: value.label,
  }
}

function formatPrice(priceFen: number): string {
  return (priceFen / 100).toFixed(2).replace(/\.?0+$/u, '')
}

function invalidResponse(): ApiError {
  return new ApiError('服务返回了无法识别的套餐数据，请稍后重试', { code: 'INVALID_RESPONSE' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
