/**
 * 小程序虚拟支付客户端：构造支付参数、计算双签名、调用 B 端服务端接口。
 *
 * 职责：只封装虚拟支付的密码学与 HTTP 通信，不涉及订单表与额度到账（那些在 payment-service）。
 * 调用方：payments/payment-service（下单签名、发货前查单验真）。
 *
 * 与 wechat-pay-client 的关系：两者是**互补而非替代**。
 * wechat-pay-client 走商户号 + APIv3 证书（适合实物/服务），本文件走 OfferID + AppKey
 * （官方要求虚拟商品必须用它，且是 iOS 端唯一合法通道）。
 *
 * 关键点：
 * - paySig 消息体必须与实际参与签名的 signData 字符串**逐字节一致**，键顺序敏感；
 * - signature 用用户 session_key 签，session_key 过期会直接导致 -15007，需引导用户重新登录；
 * - 发货推送 xpay_goods_deliver_notify **没有密码学签名**，因此发货前必须调 query_order
 *   反向验真，不能凭推送内容就发放权益；
 * - AppKey 区分沙箱/现网，env=0 用现网、env=1 用沙箱，生产环境固定 env=0。
 */
import { createHmac } from "node:crypto";
import { AppError } from "../../shared/app-error";
import type { VirtualPayConfig } from "../../config/env";

/** 道具直购：官方文档规定该 mode 下 productId 与 goodsPrice 必填。 */
export const GOODS_MODE = "short_series_goods";
/** 基础库拉起支付的固定 uri；参与 paySig 计算的字符串前缀。 */
const CLIENT_SIGN_URI = "requestVirtualPayment";
/** B 端查单接口路径，同时作为该接口 paySig 的 uri。 */
const QUERY_ORDER_URI = "/xpay/query_order";

/** 服务端下单返回给小程序端的完整支付参数。 */
export interface VirtualPaymentPayload {
  /** 已序列化完毕的 signData：必须原样透传给 wx.requestVirtualPayment，不得重新 stringify。 */
  readonly signData: string;
  readonly paySig: string;
  readonly signature: string;
  readonly mode: typeof GOODS_MODE;
}

export interface CreateVirtualPaymentInput {
  /** 业务订单号（8-32 位，数字/字母/_ - | * @，不以 _ 开头），取值 pindou_orders.id。 */
  readonly orderId: string;
  /** MP 后台道具管理里已发布的道具 ID。 */
  readonly productId: string;
  /** 单价（分），必须与 MP 后台道具定价一致，否则报 -15013。 */
  readonly goodsPriceFen: number;
  readonly buyQuantity: number;
  /** 发货回调原样回传的透传字段，这里放订单号便于对账。 */
  readonly attach: string;
  readonly sessionKey: string;
}

/** 发货推送 xpay_goods_deliver_notify 的关键字段（推送为明文，未经签名，不可作为放款依据）。 */
export interface DeliveryNotification {
  readonly openId: string;
  readonly outTradeNo: string;
  readonly env: number;
  readonly mchOrderNo: string | null;
  readonly transactionId: string | null;
  readonly paidTimeSeconds: number | null;
  readonly productId: string | null;
  readonly quantity: number | null;
  /** 实付金额（分），发货前需与订单快照比对。 */
  readonly actualPriceFen: number | null;
  readonly attach: string | null;
}

/** query_order 的标准化结果：只有 paid=true 才允许发货。 */
export interface QueriedVirtualOrder {
  readonly paid: boolean;
  readonly mchOrderNo: string | null;
  readonly transactionId: string | null;
  readonly paidTimeSeconds: number | null;
  readonly actualPriceFen: number | null;
}

/** 虚拟支付网关抽象：未配置时由 UnavailableVirtualPayGateway 顶上，避免启动期就崩。 */
export interface VirtualPayGateway {
  readonly configured: boolean;
  readonly offerId: string;
  createPayment(input: CreateVirtualPaymentInput): VirtualPaymentPayload;
  queryOrder(input: { openid: string; orderId: string }): Promise<QueriedVirtualOrder>;
}

interface ClientConfig {
  readonly offerId: string;
  readonly appKey: string;
  readonly appId: string;
  readonly timeoutMs: number;
  readonly apiBaseUrl: string;
}

function unavailable(): AppError {
  return new AppError(503, "VIRTUAL_PAYMENT_NOT_CONFIGURED", "虚拟支付尚未完成服务端配置");
}

export class UnavailableVirtualPayGateway implements VirtualPayGateway {
  public readonly configured = false;
  public readonly offerId = "";

  public createPayment(): never {
    throw unavailable();
  }

  public async queryOrder(): Promise<never> {
    throw unavailable();
  }
}

/**
 * signData 的字段顺序**必须固定**，且其序列化结果同时用于两处：
 * ① 原样下发给客户端；② 作为 paySig / signature 的签名输入。
 *
 * 单独抽成函数就是为了防止第二份实现：一旦有人用不同顺序或不同空格重新 stringify，
 * 客户端 paySig 校验必然失败，而这类差异在本地测试里几乎不可复现。
 */
function buildSignData(input: CreateVirtualPaymentInput, offerId: string): string {
  return JSON.stringify({
    offerId,
    buyQuantity: input.buyQuantity,
    // 生产环境固定现网：沙箱（1）在真机预览下会被 PAYMENT_ILLEGAL_IN_SANDBOX 拦截
    env: 0,
    currencyType: "CNY",
    productId: input.productId,
    goodsPrice: input.goodsPriceFen,
    outTradeNo: input.orderId,
    attach: input.attach,
  });
}

/** 支付签名：HMAC-SHA256(appKey, uri + "&" + body)，结果为小写 hex。 */
function signPay(uri: string, body: string, appKey: string): string {
  return createHmac("sha256", appKey).update(`${uri}&${body}`, "utf8").digest("hex");
}

/** 用户态签名：HMAC-SHA256(sessionKey, body)，结果为小写 hex。 */
function signUser(body: string, sessionKey: string): string {
  return createHmac("sha256", sessionKey).update(body, "utf8").digest("hex");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function integerOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function priceOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 已支付的订单状态。 */
const PAID_STATES = ["PAID", "SUCCESS", "1"];

/** 真实对接虚拟支付的网关实现。 */
export class OfficialVirtualPayGateway implements VirtualPayGateway {
  public readonly configured = true;
  public readonly offerId: string;

  public constructor(
    private readonly config: ClientConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.offerId = config.offerId;
  }

  /**
   * 生成拉起 wx.requestVirtualPayment 所需的全部参数。
   *
   * @throws VIRTUAL_PAYMENT_SESSION_EXPIRED session_key 缺失（对应微信 -15007）
   */
  public createPayment(input: CreateVirtualPaymentInput): VirtualPaymentPayload {
    if (!input.sessionKey) {
      throw new AppError(409, "VIRTUAL_PAYMENT_SESSION_EXPIRED", "登录状态已失效，请重新登录后支付");
    }
    const signData = buildSignData(input, this.config.offerId);
    return {
      signData,
      paySig: signPay(CLIENT_SIGN_URI, signData, this.config.appKey),
      signature: signUser(signData, input.sessionKey),
      mode: GOODS_MODE,
    };
  }

  /**
   * 主动查单（/xpay/query_order）：发货前验真的**唯一可信来源**。
   *
   * @param input.orderId 业务单号 outTradeNo（注意参数名是 order_id，不是 out_trade_no）
   * @returns paid=false 表示尚未确认支付成功，调用方一律不得发放权益
   *
   * 关于签名体的取值：官方 Python 示例先对「不含 pay_sig 的基础字段」计算签名，再把签名并入请求体。
   * 这里沿用同样的顺序（先签 baseBody，再发送含 pay_sig 的完整体），若联调报 -15006，
   * 应优先核对这一步而不是改算法。
   */
  public async queryOrder(input: {
    openid: string;
    orderId: string;
  }): Promise<QueriedVirtualOrder> {
    const baseBody = JSON.stringify({
      openid: input.openid,
      env: 0,
      order_id: input.orderId,
    });
    const body = JSON.stringify({
      ...(JSON.parse(baseBody) as Record<string, unknown>),
      appid: this.config.appId,
      pay_sig: signPay(QUERY_ORDER_URI, baseBody, this.config.appKey),
    });

    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.config.apiBaseUrl}${QUERY_ORDER_URI}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      throw new AppError(502, "VIRTUAL_PAYMENT_PROVIDER_UNAVAILABLE", "虚拟支付服务暂时不可用");
    }
    if (!response.ok) {
      throw new AppError(502, "VIRTUAL_PAYMENT_PROVIDER_ERROR", "虚拟支付订单查询失败");
    }

    const record = await parseResponseRecord(response);
    const errCode = integerOrNull(record.errcode) ?? integerOrNull(record.errCode);
    if (errCode !== null && errCode !== 0) {
      throw new AppError(502, "VIRTUAL_PAYMENT_PROVIDER_ERROR", `虚拟支付订单查询失败（${errCode}）`);
    }

    /**
     * 状态字段名在不同版本下不一致（pay_state / payState / order_state），取其一明示成功即判已支付。
     * **刻意采用 fail-closed**：无法识别状态时不发货。
     * 少发货最多是体验问题，错发货等于白送钱且会被刷，两者的代价不对等。
     */
    const payState = stringOrNull(record.pay_state)
      ?? stringOrNull(record.payState)
      ?? stringOrNull(record.order_state);
    const paid = payState !== null && PAID_STATES.includes(payState.toUpperCase());

    return {
      paid,
      mchOrderNo: stringOrNull(record.mch_order_no) ?? stringOrNull(record.mchOrderNo),
      transactionId: stringOrNull(record.transaction_id) ?? stringOrNull(record.transactionId),
      paidTimeSeconds: integerOrNull(record.paid_time) ?? integerOrNull(record.paidTime),
      actualPriceFen: priceOrNull(record.actual_price) ?? priceOrNull(record.actualPrice),
    };
  }
}

async function parseResponseRecord(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
  } catch {
    throw new AppError(502, "VIRTUAL_PAYMENT_INVALID_RESPONSE", "虚拟支付返回了无效响应");
  }
  throw new AppError(502, "VIRTUAL_PAYMENT_INVALID_RESPONSE", "虚拟支付返回了无效响应");
}

export function createVirtualPayGateway(config: VirtualPayConfig): VirtualPayGateway {
  if (!config.enabled) return new UnavailableVirtualPayGateway();
  return new OfficialVirtualPayGateway({
    offerId: config.offerId,
    appKey: config.appKey,
    appId: config.appId,
    timeoutMs: config.timeoutMs,
    apiBaseUrl: config.apiBaseUrl,
  });
}
