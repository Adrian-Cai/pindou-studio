/**
 * 微信支付下单与拉起支付（小程序端网络层）。
 *
 * 职责：获取 AI 生成套餐列表、创建支付订单并调起 wx.requestPayment、判断支付取消、
 *       把服务端 JSON 解析成强类型（套餐/支付参数/创建回执）。不直接处理回调——
 *       微信支付回调由服务端 wechat-pay-client 验签处理。
 * 调用方：packages/payment 下各页面（recharge、payment-success 等）。
 * 关键点：下单带 Idempotency-Key 防重复扣款；支付参数必须校验 prepay_id= 前缀；未登录直接抛 UNAUTHORIZED。
 */
import { ApiError, apiRequest } from './http-client'
import { isAuthSessionExpired, loadAuthSession } from './token-storage'

/** 拉起 wx.requestPayment 所需的小程序支付参数（RSA 签名）。 */
export interface WeChatPaymentParameters {
  timeStamp: string
  nonceStr: string
  package: string
  signType: 'RSA'
  paySign: string
}

/** 创建支付订单的回执：订单号 + 拉起支付所需的参数。 */
export interface CreatePaymentResponse {
  orderId: string
  payment: WeChatPaymentParameters
}

/** AI 生成次数套餐：id、可生成次数、展示价、文案标签。 */
export interface AiGenerationPackage {
  id: string
  count: number
  price: string
  label: string
}

/** 获取可购买的 AI 生成套餐列表（/api/packages），返回前端展示用结构。 */
export async function fetchAiGenerationPackages(): Promise<AiGenerationPackage[]> {
  const response = await apiRequest<unknown>({ path: '/api/packages' })
  return parsePackages(response)
}

async function createAiGenerationPayment(
  packageId: string,
  idempotencyKey: string,
): Promise<CreatePaymentResponse> {
  const normalizedPackageId = packageId.trim()
  if (!normalizedPackageId || !idempotencyKey.trim()) {
    throw new ApiError('支付参数无效，请重新选择套餐', { code: 'INVALID_ARGUMENT' })
  }
  const response = await apiRequest<unknown>({
    path: '/api/payments/create',
    method: 'POST',
    token: requireToken(),
    headers: { 'Idempotency-Key': idempotencyKey },
    data: { packageId: normalizedPackageId },
    // 下单接口超时 15 秒，避免长时间阻塞支付流程
    timeoutMs: 15_000,
  })
  return parseCreatePayment(response)
}

/**
 * 购买 AI 套餐：创建订单后立即拉起微信支付，返回 orderId（用于跳支付成功页轮询结果）。
 *
 * @param idempotencyKey **必须按用户「一次购买意图」生成并持有**。最早这里是在内部
 *   每次调用都现场造一个默认值，于是同一次点击走到两次（或页面重进入）就被判成两笔不同订单，
 *   服务端去重完全失效。因此必须由调用方（UI 手势）在发起前生成、并在重试时复用同一个键。
 */
export async function payForAiGenerationPackage(
  packageId: string,
  idempotencyKey: string,
): Promise<CreatePaymentResponse> {
  const normalizedKey = idempotencyKey.trim()
  if (!normalizedKey) {
    throw new ApiError('支付参数无效，请重新发起支付', { code: 'INVALID_ARGUMENT' })
  }
  const created = await createAiGenerationPayment(packageId, normalizedKey)
  await requestWechatPayment(created.payment)
  return created
}

/**
 * 生成一次购买意图的幂等键（时间戳 + 随机串）。
 * 调用方应把它存在页面状态里：**同一次点击的重试必须复用同一个键**，否则服务端会当成新订单。
 */
export function createPaymentIdempotencyKey(): string {
  return `payment-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`
}

function requestWechatPayment(payment: WeChatPaymentParameters): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.requestPayment({
      ...payment,
      success: () => resolve(),
      fail: (error) => reject(error),
    })
  })
}

/** 判断 wx.requestPayment 的失败是否为“用户主动取消”（errMsg 含 requestPayment:fail cancel）。 */
export function isWechatPaymentCancelled(error: unknown): boolean {
  const message = isRecord(error) && typeof error.errMsg === 'string' ? error.errMsg : ''
  return message.includes('requestPayment:fail cancel')
}

/** 把支付失败错误归一化为用户可读文案，无 message 时回退默认提示。 */
export function paymentErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : '支付未完成，请稍后重试'
}

function parsePackages(value: unknown): AiGenerationPackage[] {
  if (!isRecord(value) || !Array.isArray(value.items)) throw invalidResponse()
  return value.items.map(parsePackage)
}

function parseCreatePayment(value: unknown): CreatePaymentResponse {
  if (!isRecord(value)
    || typeof value.orderId !== 'string'
    || !value.orderId
    || !isRecord(value.payment)) throw invalidResponse()
  return {
    orderId: value.orderId,
    payment: parsePaymentParameters(value.payment),
  }
}

function parsePaymentParameters(value: Record<string, unknown>): WeChatPaymentParameters {
  if (typeof value.timeStamp !== 'string'
    || !value.timeStamp
    || typeof value.nonceStr !== 'string'
    || !value.nonceStr
    || typeof value.package !== 'string'
    // package 必须以 prepay_id= 开头，否则不是合法的小程序支付参数
    || !value.package.startsWith('prepay_id=')
    || typeof value.paySign !== 'string'
    || !value.paySign
    || value.signType !== 'RSA') throw invalidResponse()
  return {
    timeStamp: value.timeStamp,
    nonceStr: value.nonceStr,
    package: value.package,
    signType: 'RSA',
    paySign: value.paySign,
  }
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

function requireToken(): string {
  const session = loadAuthSession()
  if (!session || isAuthSessionExpired(session)) {
    throw new ApiError('请先登录后再发起支付', { statusCode: 401, code: 'UNAUTHORIZED' })
  }
  return session.token
}
