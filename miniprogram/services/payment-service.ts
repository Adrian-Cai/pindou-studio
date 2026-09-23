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
 * 生成一次购买意图的幂等键（时间戳 + 密码学随机串）。
 * 调用方应把它存在页面状态里：**同一次点击的重试必须复用同一个键**，否则服务端会当成新订单。
 *
 * 随机分量走 CSPRNG 而非 Math.random：这是一笔钱的去重凭据，同一毫秒内连点两次
 * 撞键的后果是「用户付了两次」。Math.random 不保证不可预测，也不保证不同实现下的
 * 分布质量，拿它挡重复扣款不合格。
 */
export function createPaymentIdempotencyKey(): string {
  return `payment-${Date.now()}-${randomHex(8)}`
}

/**
 * 生成 16 进制随机串。
 *
 * 小程序环境只有 `wx.getRandomValues`（不存在 Web 的 crypto 全局），拿不到时只能降级；
 * 这种情况实际不会发生，留着是为了让发布端配置异常时不至于直接崩在支付入口上。
 */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  if (typeof wx.getRandomValues === 'function') {
    wx.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  console.warn('[payment] 当前环境缺少安全随机源，幂等键降级为弱随机')
  weakRandomFill(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function weakRandomFill(bytes: Uint8Array): void {
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
}

/**
 * 拉起 wx.requestPayment。
 *
 * 微信的 fail 回调给的是 `{ errMsg, errCode }` 这样的**裸对象**，既不是 Error 也不是 ApiError。
 * 直接 reject 会让下游 `paymentErrorMessage`（只看 Error 实例）永远走兜底文案 ——
 * 用户明明是自己取消的，却看到「请稍后重试」。这里统一收成 ApiError。
 */
function requestWechatPayment(payment: WeChatPaymentParameters): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.requestPayment({
      ...payment,
      success: () => resolve(),
      fail: (error) => reject(toPaymentApiError(error)),
    })
  })
}

/** 把微信支付的裸失败对象归一成 ApiError（保留 errCode 供取消判定使用）。 */
function toPaymentApiError(error: unknown): ApiError {
  const record = isRecord(error) ? error : {}
  const errMsg = typeof record.errMsg === 'string' ? record.errMsg : ''
  const errCode = typeof record.errCode === 'number' ? record.errCode : null
  if (isWechatPaymentCancelled(error)) {
    return new ApiError('已取消支付', { code: WECHAT_PAYMENT_CANCELLED, details: { errMsg, errCode } })
  }
  return new ApiError(
    errMsg || '微信支付拉起失败，请稍后重试',
    { code: WECHAT_PAYMENT_FAILED, details: { errMsg, errCode } },
  )
}

/** 用户主动取消支付：errCode -2 是微信文档的取值，errMsg 文案跨版本/语言会变。 */
const WECHAT_PAYMENT_CANCELLED = 'WECHAT_PAYMENT_CANCELLED'
/** 支付拉起失败的其它原因（余额不足、参数错误等）。 */
const WECHAT_PAYMENT_FAILED = 'WECHAT_PAYMENT_FAILED'
/** 微信文档的用户取消码；老版本基础库不给 errCode，只能退而match errMsg。 */
const WECHAT_CANCEL_ERR_CODE = -2

/**
 * 判断 wx.requestPayment 的失败是否为“用户主动取消”。
 *
 * 优先看结构化的 errCode（-2 是微信文档的取消码）。只在拿不到 errCode 时
 * 才退回子串匹配 —— errMsg 会随基础库版本与系统语言变化，把文案当判据并不可靠。
 * 归一化后的 ApiError 也带 code，因此两条路径（原始 wx 对象 / ApiError）都能判。
 */
export function isWechatPaymentCancelled(error: unknown): boolean {
  if (error instanceof ApiError) return error.code === WECHAT_PAYMENT_CANCELLED
  if (!isRecord(error)) return false
  if (error.errCode === WECHAT_CANCEL_ERR_CODE) return true
  const details = isRecord(error.details) ? error.details : null
  if (details?.errCode === WECHAT_CANCEL_ERR_CODE) return true
  const message = typeof error.errMsg === 'string' ? error.errMsg : ''
  return message.includes('requestPayment:fail cancel')
}

/** 把支付失败错误归一化为用户可读文案，无 message 时回退默认提示。 */
export function paymentErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  // wx.requestPayment 的裸对象不是 Error：兜不住就只能给通用文案。
  // 正常路径上 requestWechatPayment 已经收成 ApiError，这里是防御旧调用方。
  if (isRecord(error) && typeof error.errMsg === 'string' && error.errMsg) return error.errMsg
  return '支付未完成，请稍后重试'
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

/**
 * 解析单个套餐。
 *
 * 刻意**只校验真正要展示的字段**（id / label / quotaAmount / priceFen）。
 * 早期版本把 quotaKind、membershipType、currency、enabled 也一并校验并写死期望值，
 * 结果服务端一调整套餐种类（比如新增会员套餐），`parsePackages` 整份 map 抛错，
 * 用户界面上一个套餐都不剩，报错还是「无法识别的套餐数据」这种看不出所以然的文案。
 * 那些字段属于服务端内部约定，不该成为客户端能否渲染的前提。
 */
function parsePackage(value: unknown): AiGenerationPackage {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || !value.id
    || typeof value.label !== 'string'
    || !value.label
    || !isPositiveSafeInteger(value.quotaAmount)
    || !isPositiveSafeInteger(value.priceFen)
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
