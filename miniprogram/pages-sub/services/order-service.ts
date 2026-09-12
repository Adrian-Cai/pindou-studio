import type { OrderItem, OrderListResponse, OrderStatus } from '../../models/order'
import { isAuthSessionExpired, loadAuthSession } from '../../services/token-storage'
import { ApiError, apiRequest } from '../../services/http-client'

export async function fetchOrders(options: {
  page?: number
  pageSize?: number
} = {}): Promise<OrderListResponse> {
  const page = options.page ?? 1
  const pageSize = options.pageSize ?? 20
  const response = await apiRequest<unknown>({
    path: `/api/orders?page=${page}&pageSize=${pageSize}`,
    token: requireToken(),
  })
  return parseOrderList(response)
}

function parseOrderList(value: unknown): OrderListResponse {
  if (!isRecord(value)
    || !isNonNegativeSafeInteger(value.total)
    || !isPositiveSafeInteger(value.page)
    || !isPositiveSafeInteger(value.pageSize)
    || value.pageSize > 50
    || !Array.isArray(value.items)) throw invalidResponse()
  return {
    total: value.total,
    page: value.page,
    pageSize: value.pageSize,
    items: value.items.map(parseOrderItem),
  }
}

function parseOrderItem(value: unknown): OrderItem {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || !value.id
    || (value.packageId !== null && typeof value.packageId !== 'string')
    || typeof value.packageLabel !== 'string'
    || !value.packageLabel
    || !isPositiveSafeInteger(value.quotaAmount)
    || value.quotaKind !== 'ai_generation'
    || !isNonNegativeSafeInteger(value.priceFen)
    || value.currency !== 'CNY'
    || !isOrderStatus(value.status)
    || !isIsoDate(value.createdAt)
    || (value.paidAt !== null && !isIsoDate(value.paidAt))) throw invalidResponse()
  return {
    id: value.id,
    packageId: value.packageId,
    packageLabel: value.packageLabel,
    quotaAmount: value.quotaAmount,
    quotaKind: 'ai_generation',
    priceFen: value.priceFen,
    currency: 'CNY',
    status: value.status,
    createdAt: value.createdAt,
    paidAt: value.paidAt,
  }
}

function isOrderStatus(value: unknown): value is OrderStatus {
  return value === 'pending'
    || value === 'paid'
    || value === 'failed'
    || value === 'closed'
    || value === 'refunded'
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function requireToken(): string {
  const session = loadAuthSession()
  if (!session || isAuthSessionExpired(session)) {
    throw new ApiError('请先登录后再查看订单', { statusCode: 401, code: 'UNAUTHORIZED' })
  }
  return session.token
}

function invalidResponse(): ApiError {
  return new ApiError('服务返回了无法识别的订单数据，请稍后重试', { code: 'INVALID_RESPONSE' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
