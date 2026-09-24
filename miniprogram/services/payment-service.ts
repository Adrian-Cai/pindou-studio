/**
 * 虚拟支付下单与拉起支付（小程序端网络层）。
 *
 * 职责：获取 AI 生成套餐列表、创建订单并调起 wx.requestVirtualPayment、判断支付取消、
 *       把服务端 JSON 解析成强类型。不处理发货——发货由服务端收到发货推送并验真后完成。
 * 调用方：packages/payment 下各页面（recharge、payment-success 等）。
 *
 * 为什么是虚拟支付而非普通微信支付：小程序内售卖的 AI 生成次数属于虚拟商品，
 * 官方要求这类交易的购买与支付必须走小程序虚拟支付，且它是 iOS 端唯一合法通道
 * （普通 wx.requestPayment 在 iOS 上无法购买虚拟商品）。
 *
 * 关键点：下单带 Idempotency-Key 防重复扣款；signData 必须原样透传不得二次序列化；
 *         拉起前必须校验基础库支持，低版本要给出可理解提示而不是直接崩；
 *         前端 success 回调只是 UI 反馈，权益到账以服务端为准。
 */
import { ApiError, apiRequest } from './http-client'
import { isAuthSessionExpired, loadAuthSession } from './token-storage'

/**
 * wx.requestVirtualPayment 的 signData。
 *
 * 注意运行时与类型定义的差异：官方**运行时**要求 signData 以 string 传入，
 * 但 miniprogram-api-typings 把它声明成对象，两者不一致，调用处需要断言。
 *
 * 这里的类型只用于**校验**解析结果的字段（见 parseSignData），不用于传参：
 * 曾经把解析出的对象传给 API，结果微信直接报
 * `parameter.signData should be String instead of Object`，支付一步都走不出去。
 */
export interface VirtualSignData {
  offerId: string
  buyQuantity: number
  env: number
  /** 官方目前仅支持 CNY，与 typings 的字面量约束保持一致。 */
  currencyType: 'CNY'
  productId: string
  goodsPrice: number
  outTradeNo: string
  attach: string
}

/** 服务端签发的虚拟支付参数。 */
export interface VirtualPaymentPayload {
  /** 服务端序列化好的签名数据，**禁止重新 JSON.stringify**，否则 paySig 校验失败。 */
  signData: string
  paySig: string
  signature: string
  mode: string
}

/** 创建支付订单的回执：订单号 + 拉起虚拟支付所需的参数。 */
export interface CreatePaymentResponse {
  orderId: string
  virtual: VirtualPaymentPayload | null
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
 * 购买 AI 套餐：创建订单后立即拉起虚拟支付，返回 orderId（用于跳支付结果页轮询）。
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
  if (!created.virtual) {
    throw new ApiError('支付参数已失效，请重新发起支付', { code: 'INVALID_RESPONSE' })
  }
  await requestVirtualPayment(created.virtual)
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

/** wx.requestVirtualPayment 在基础库 2.19.2 起提供；低于此版本需走 canIUse 兜底判断。 */
const VIRTUAL_PAYMENT_BASELINE = '2.19.2'

/**
 * 当前环境是否可以发起虚拟支付。
 *
 * 不能只看 canIUse：它只反映「接口存在与否」，某些宿主（含部分 iOS 微信客户端）
 * 存在接口但不起作用的情形。因此这里**先过版本号门槛，再看 canIUse**，
 * 两者满足其一即放行 —— 与官方示例的推荐写法保持一致。
 */
export function canUseVirtualPayment(): boolean {
  if (typeof wx.requestVirtualPayment !== 'function') return false
  const sdkVersion = readSdkVersion()
  if (!sdkVersion) return true
  return compareVersion(sdkVersion, VIRTUAL_PAYMENT_BASELINE) >= 0
    || Boolean(wx.canIUse?.('requestVirtualPayment'))
}

function readSdkVersion(): string | null {
  try {
    const info = wx.getSystemInfoSync?.() as { SDKVersion?: unknown } | undefined
    return typeof info?.SDKVersion === 'string' ? info.SDKVersion : null
  } catch {
    // getSystemInfoSync 在个别宿主下会抛错；拿不到就退回 canIUse 判定
    return null
  }
}

/** 版本号比较：v1 > v2 返回 1，小于返回 -1，相等返回 0；格式异常视作相等。 */
function compareVersion(first: string, second: string): number {
  const left = first.split('.')
  const right = second.split('.')
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = Number.parseInt(left[index] ?? '0', 10)
    const b = Number.parseInt(right[index] ?? '0', 10)
    if (Number.isNaN(a) || Number.isNaN(b)) return 0
    if (a > b) return 1
    if (a < b) return -1
  }
  return 0
}

/**
 * 拉起 wx.requestVirtualPayment。
 *
 * signData 必须是服务端原样下发的字符串：本地哪怕按同样字段重新 stringify，
 * 序列化结果的一个空格差异都会让 paySig 校验失败。
 *
 * 微信的 fail 回调给的是 `{ errMsg, errCode }` 这样的**裸对象**，既不是 Error 也不是 ApiError。
 * 直接 reject 会让下游 `paymentErrorMessage`（只看 Error 实例）永远走兜底文案 ——
 * 用户明明是自己取消的，却看到「请稍后重试」。这里统一收成 ApiError。
 */
function requestVirtualPayment(payload: VirtualPaymentPayload): Promise<void> {
  if (!canUseVirtualPayment()) {
    return Promise.reject(
      new ApiError('当前微信版本不支持虚拟支付，请升级微信后重试', {
        code: VIRTUAL_PAYMENT_UNSUPPORTED,
      }),
    )
  }
  // signData 先解析一次只为校验：它是合法 JSON 才继续。带着坏数据去拉起支付，
  // 微信只会回一句笼统的 -15001「参数错误」，排查时分不清是服务端下发还是客户端解析的问题。
  // 注意**校验完就把解析结果丢掉**——真正传给 API 的必须是原字符串，见下方说明。
  parseSignData(payload.signData)
  return new Promise((resolve, reject) => {
    wx.requestVirtualPayment({
      /**
       * 官方**运行时**只接受 string，传对象会直接报
       * `parameter.signData should be String instead of Object`。
       * 而 miniprogram-api-typings 把它声明成对象，两者不一致，只能在这里断言。
       *
       * 必须原样透传服务端那份字符串：本地哪怕按同样字段重新 stringify，
       * 序列化结果的一个空格差异都会让 paySig 校验失败——签名输入是那份字符串本身。
       */
      signData: payload.signData as unknown as VirtualSignData,
      paySig: payload.paySig,
      signature: payload.signature,
      mode: payload.mode as 'short_series_goods',
      success: () => resolve(),
      fail: (error) => reject(toPaymentApiError(error)),
    })
  })
}

/**
 * 还原服务端签发的 signData 字符串。
 *
 * 解析失败必须抛明确错误：带着空对象去拉起支付，微信只会回一句笼统的
 * -15001「参数错误」，排查时完全看不出是服务端下发问题还是客户端解析问题。
 */
function parseSignData(signData: string): VirtualSignData {
  try {
    const parsed: unknown = JSON.parse(signData)
    if (!isRecord(parsed)) throw new Error('signData 不是对象')
    return parsed as unknown as VirtualSignData
  } catch {
    throw new ApiError('支付参数解析失败，请重新发起支付', { code: 'INVALID_RESPONSE' })
  }
}

/**
 * 把微信支付裸失败对象归一成 ApiError（保留 errCode 供上层判定与排查）。
 *
 * 虚拟支付的错误码是一串负整数（如 -15007），直接展示给用户既看不懂也无法自助处理。
 * 这里把高频且**用户自己能解决**的几类翻译成可行动文案；其余保留原始信息，
 * 便于在日志里定位，不至于被泛化文案吞掉。
 */
function toPaymentApiError(error: unknown): ApiError {
  const record = isRecord(error) ? error : {}
  const errMsg = typeof record.errMsg === 'string' ? record.errMsg : ''
  const errCode = typeof record.errCode === 'number' ? record.errCode : null
  if (isWechatPaymentCancelled(error)) {
    return new ApiError('已取消支付', { code: WECHAT_PAYMENT_CANCELLED, details: { errMsg, errCode } })
  }
  /**
   * 商户单号作废：微信侧这张单已经关了（-15012）或单号撞了（-15002）。
   *
   * 单独成一个 code 而不是只给一句文案，是因为调用方必须**换一笔新单**才能继续 ——
   * 保留原幂等键重试只会反复撞同一个已关闭的单号。
   */
  if (errCode === VIRTUAL_ORDER_CLOSED_ERR_CODE || errCode === VIRTUAL_OUT_TRADE_NO_REUSED_ERR_CODE) {
    return new ApiError('订单已失效，请重新发起支付', {
      code: WECHAT_PAYMENT_ORDER_CLOSED,
      details: { errMsg, errCode },
    })
  }
  const friendly = errCode === null ? null : VIRTUAL_PAYMENT_ERROR_TEXT[errCode]
  return new ApiError(
    friendly ?? errMsg ?? '支付未完成，请稍后重试',
    { code: WECHAT_PAYMENT_FAILED, details: { errMsg, errCode } },
  )
}

/** 虚拟支付常见错误码 → 用户可理解且可行动的文案。 */
const VIRTUAL_PAYMENT_ERROR_TEXT: Readonly<Record<number, string>> = {
  // 业务单号重复：客户端应换幂等键重下，而不是让用户对着 raw code 发呆
  [-15002]: '订单已失效，请重新发起支付',
  // 调用米大师失败导致关单：官方口径「请换新单号重试」
  [-15012]: '订单已失效，请重新发起支付',
  [-15004]: '支付币种异常，请联系客服',
  [-15007]: '登录状态已失效，请重新登录后支付',
  [-15010]: '商品暂不可购买，请稍后再试',
  [-15013]: '商品价格异常，请联系客服',
  [-15014]: '商品刚刚上架，请稍等几分钟后重试',
  [-15017]: '商家收款功能受限，请联系客服',
  [-15020]: '操作过于频繁，请稍候再试',
  [-15021]: '当前下单过于集中，请稍后再试',
}

/** 用户主动取消支付：errCode -2 是微信文档的取值，errMsg 文案跨版本/语言会变。 */
const WECHAT_PAYMENT_CANCELLED = 'WECHAT_PAYMENT_CANCELLED'
/** 商户单号已作废，必须换一笔新单才能继续支付（详见 toPaymentApiError）。 */
const WECHAT_PAYMENT_ORDER_CLOSED = 'WECHAT_PAYMENT_ORDER_CLOSED'
/** 支付拉起失败的其它原因（余额不足、参数错误等）。 */
const WECHAT_PAYMENT_FAILED = 'WECHAT_PAYMENT_FAILED'
/** 当前微信客户端不支持虚拟支付，需用户升级。 */
const VIRTUAL_PAYMENT_UNSUPPORTED = 'VIRTUAL_PAYMENT_UNSUPPORTED'
/** 微信文档的用户取消码；老版本基础库不给 errCode，只能退而match errMsg。 */
const WECHAT_CANCEL_ERR_CODE = -2
/** -15012：微信侧这张单已经关了（ORDER_CLOSED），沿用旧单号必然再失败。 */
const VIRTUAL_ORDER_CLOSED_ERR_CODE = -15012
/** -15002：outTradeNo 重复使用。 */
const VIRTUAL_OUT_TRADE_NO_REUSED_ERR_CODE = -15002

/**
 * 判断支付失败是否为“用户主动取消”。
 *
 * 虚拟支付（wx.requestVirtualPayment）与普通支付（wx.requestPayment）都适用：
 * 两者都用 errCode=-2 表示用户取消。优先看结构化的 errCode，只在拿不到时
 * 才退回子串匹配 —— errMsg 会随基础库版本与系统语言变化，把文案当判据并不可靠。
 * 两种 API 的 errMsg 前缀不同（requestPayment / requestVirtualPayment），因此这里两个都判。
 */
export function isWechatPaymentCancelled(error: unknown): boolean {
  if (error instanceof ApiError) return error.code === WECHAT_PAYMENT_CANCELLED
  if (!isRecord(error)) return false
  if (error.errCode === WECHAT_CANCEL_ERR_CODE) return true
  const details = isRecord(error.details) ? error.details : null
  if (details?.errCode === WECHAT_CANCEL_ERR_CODE) return true
  const message = typeof error.errMsg === 'string' ? error.errMsg : ''
  return message.includes(':fail cancel')
}

/**
 * 判断支付失败是否因为「商户单号已作废」。
 *
 * 与「用户取消」分开判定：取消可以原样再来一次，单号作废则必须开一笔新单，
 * 否则服务端即便换了单号，用户手里的旧意图也已经没有意义。
 */
export function isWechatPaymentOrderClosed(error: unknown): boolean {
  if (error instanceof ApiError) return error.code === WECHAT_PAYMENT_ORDER_CLOSED
  if (!isRecord(error)) return false
  const code = error.errCode ?? (isRecord(error.details) ? error.details.errCode : null)
  return code === VIRTUAL_ORDER_CLOSED_ERR_CODE || code === VIRTUAL_OUT_TRADE_NO_REUSED_ERR_CODE
}

/** 把支付失败错误归一化为用户可读文案，无 message 时回退默认提示。 */
export function paymentErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  // wx 支付 API 的裸对象不是 Error：兜不住就只能给通用文案。
  // 正常路径上 requestVirtualPayment 已经收成 ApiError，这里是防御旧调用方。
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
    || !value.orderId) throw invalidResponse()
  // virtual 为 null / undefined 是「单已建好、但服务端没签发支付参数」的可预期状态
  // （虚拟支付未启用、或服务端降级到不拉起支付）。这里**不能**抛 invalidResponse：
  // 那是一句「套餐数据无法识别」的口径，单其实建成功了，会把排查方向整个带偏。
  // 交给 payForAiGenerationPackage 统一抛「支付参数已失效」，那里才说得清发生了什么。
  if (value.virtual === null || value.virtual === undefined) {
    return { orderId: value.orderId, virtual: null }
  }
  if (!isRecord(value.virtual)) throw invalidResponse()
  return {
    orderId: value.orderId,
    virtual: parseVirtualPayment(value.virtual),
  }
}

/**
 * 解析服务端签发的虚拟支付参数。
 *
 * 三个签名相关字段都必须非空字符串：缺任意一个客户端都会报签名错误（-15005/-15006），
 * 而这类错误的文案看不出是服务端漏下发还是传参被截断。这里在_parse 阶段就拦住，
 * 让问题止步于可控的中文提示。
 */
function parseVirtualPayment(value: Record<string, unknown>): VirtualPaymentPayload {
  if (typeof value.signData !== 'string'
    || !value.signData
    || typeof value.paySig !== 'string'
    || !value.paySig
    || typeof value.signature !== 'string'
    || !value.signature
    || typeof value.mode !== 'string'
    || !value.mode) throw invalidResponse()
  return {
    signData: value.signData,
    paySig: value.paySig,
    signature: value.signature,
    mode: value.mode,
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
