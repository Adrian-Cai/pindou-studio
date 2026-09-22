/**
 * 订单服务：拉取「我的订单」列表，并对服务端返回做严格校验。
 *
 * 职责：只负责订单列表的读取与响应解析，不负责下单与支付（下单见 services/payment-service.ts）。
 * 调用方：packages/payment/orders（订单列表页）、packages/payment/payment-success（支付成功页轮询订单状态）。
 * 关键点：服务端返回属于外部输入，全部字段逐项校验后才落到 OrderItem；
 *         未登录时抛 401 ApiError，交给页面跳转登录，而不是静默返回空列表。
 */
import type { OrderItem, OrderListResponse, OrderStatus } from '../../../models/order'
import { isAuthSessionExpired, loadAuthSession } from '../../../services/token-storage'
import { ApiError, apiRequest } from '../../../services/http-client'

/**
 * 分页拉取当前用户的订单列表。
 *
 * @param options.page 页码，从 1 开始，默认 1
 * @param options.pageSize 每页条数，默认 20
 * @returns 订单列表响应（total / page / pageSize / items）
 * @throws ApiError 未登录（401）或服务端返回结构无法识别（INVALID_RESPONSE）
 */
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

/** 校验单条订单；quotaKind 目前只支持 ai_generation，币种只支持 CNY。 */
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

/** 订单状态白名单：pending 待支付 / paid 已支付 / failed 失败 / closed 已关闭 / refunded 已退款。 */
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
