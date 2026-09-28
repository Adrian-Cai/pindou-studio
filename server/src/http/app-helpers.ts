import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseHealthProvider } from "../db/database-runtime";
import type { AuthLoginService } from "../modules/auth/auth-service";
import type { RequestAuthenticator } from "../modules/auth/authenticator";
import type { AvatarStorage } from "../modules/users/avatar-storage";
import type { UserProfileService } from "../modules/users/user-profile-service";
import type { FileAssetService } from "../modules/files/file-asset-service";
import type { CoverStorage } from "../modules/files/cover-storage";
import type { AiFileStorage } from "../modules/files/ai-file-storage";
import type { ContentSecurityService } from "../modules/content-security/content-security-service";
import type { PostgresAiGenerationService } from "../modules/ai/ai-generation-service";
import type { DownloadListOptions, PostgresQuotaDownloadService } from "../modules/downloads/quota-download-service";
import type { OrderListOptions, PaymentService } from "../modules/payments/payment-service";
import type {
  DeliveryNotification,
  IosRefundQueryNotification,
  RefundNotification,
} from "../modules/payments/virtual-pay-client";
import type { VirtualPayPushCredentials } from "../modules/payments/virtual-pay-push";
import type { FavoriteListOptions, PostgresWorkService, WorkStatus } from "../modules/works/work-service";
import type { AiPublicFailure } from "../modules/ai/error-contract";
import { AppError, invalidArgument } from "../shared/app-error";
import type { InMemoryRateLimiter } from "./rate-limit";
import { xmlValue } from "./request-body";

export const DELIVERY_EVENT = "xpay_goods_deliver_notify";
export const REFUND_EVENT = "xpay_refund_notify";
export const IOS_REFUND_QUERY_EVENT = "xpay_subscribe_ios_refund_query_notify";

interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly category?: AiPublicFailure["category"];
    readonly retryable?: boolean;
    readonly action?: AiPublicFailure["action"];
    readonly requestId: string;
    readonly details: Readonly<Record<string, unknown>>;
  };
}

function requestId(): string {
  return `req_${randomUUID().replace(/-/g, "")}`;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

function sendRaw(response: ServerResponse, statusCode: number, contentType: string, body: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", `${contentType}; charset=utf-8`);
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

/**
 * 解析虚拟支付发货推送（xpay_goods_deliver_notify）。平台可能以 XML 或 JSON 投递，两种都要接。
 *
 * @returns null 表示这不是发货推送（例如别的 xpay_* 事件），调用方应直接回成功避免平台重试
 * @throws invalidArgument 报文无法解析
 *
 * 这里解析出的推送字段只用于定位订单，不直接证明支付成功；是否发货由 payment-service
 * 侧调用 query_order 核实微信事实后决定。
 */
function parseDeliveryNotification(rawBody: string): DeliveryNotification | null {
  const trimmed = rawBody.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw invalidArgument("虚拟支付推送 JSON 格式不正确");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalidArgument("虚拟支付推送格式不正确");
    }
    const record = parsed as Record<string, unknown>;
    if (stringField(record, "Event") !== DELIVERY_EVENT) return null;
    const wechatPay = objectField(record, "WeChatPayInfo");
    const goods = objectField(record, "GoodsInfo");
    return {
      openId: stringField(record, "OpenId") ?? "",
      outTradeNo: stringField(record, "OutTradeNo") ?? "",
      env: numberField(record, "Env") ?? 0,
      mchOrderNo: stringField(wechatPay, "MchOrderNo"),
      transactionId: stringField(wechatPay, "TransactionId"),
      paidTimeSeconds: numberField(wechatPay, "PaidTime"),
      productId: stringField(goods, "ProductId"),
      quantity: numberField(goods, "Quantity"),
      actualPriceFen: numberField(goods, "ActualPrice"),
      attach: stringField(goods, "Attach"),
    };
  }

  if (xmlValue(rawBody, "Event") !== DELIVERY_EVENT) return null;
  return {
    openId: xmlValue(rawBody, "OpenId") ?? "",
    outTradeNo: xmlValue(rawBody, "OutTradeNo") ?? "",
    env: readNumber(xmlValue(rawBody, "Env")) ?? 0,
    mchOrderNo: xmlValue(rawBody, "MchOrderNo"),
    transactionId: xmlValue(rawBody, "TransactionId"),
    paidTimeSeconds: readNumber(xmlValue(rawBody, "PaidTime")),
    productId: xmlValue(rawBody, "ProductId"),
    quantity: readNumber(xmlValue(rawBody, "Quantity")),
    actualPriceFen: readNumber(xmlValue(rawBody, "ActualPrice")),
    attach: xmlValue(rawBody, "Attach"),
  };
}

/**
 * 取出推送的事件名（XML 与 JSON 两种投递都要支持）。
 *
 * 抽出来是因为路由必须先知道「这是哪一类事件」才能决定怎么应答：
 * 退款问询要回 JSON 业务结果，其余事件回 ErrCode。
 */
function parseEventName(rawBody: string): string | null {
  const trimmed = rawBody.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return stringField(parsed as Record<string, unknown>, "Event");
  }
  return xmlValue(trimmed, "Event");
}

/**
 * 解析退款推送（xpay_refund_notify）。
 *
 * 同样没有签名，字段只用于定位订单；是否真的扣回由 payment-service 侧按订单状态决定。
 */
function parseRefundNotification(rawBody: string): RefundNotification {
  const trimmed = rawBody.trim();
  if (trimmed.startsWith("{")) {
    const record = parseJsonRecord(trimmed);
    return {
      openId: stringField(record, "OpenId") ?? "",
      mchOrderId: stringField(record, "MchOrderId"),
      attach: stringField(record, "Attach"),
      wxRefundId: stringField(record, "WxRefundId"),
      refundFeeFen: numberField(record, "RefundFee"),
      retCode: numberField(record, "RetCode"),
      retMsg: stringField(record, "RetMsg"),
      refundSuccTimestamp: numberField(record, "RefundSuccTimestamp"),
    };
  }
  return {
    openId: xmlValue(trimmed, "OpenId") ?? "",
    mchOrderId: xmlValue(trimmed, "MchOrderId"),
    attach: xmlValue(trimmed, "Attach"),
    wxRefundId: xmlValue(trimmed, "WxRefundId"),
    refundFeeFen: readNumber(xmlValue(trimmed, "RefundFee")),
    retCode: readNumber(xmlValue(trimmed, "RetCode")),
    retMsg: xmlValue(trimmed, "RetMsg"),
    refundSuccTimestamp: readNumber(xmlValue(trimmed, "RefundSuccTimestamp")),
  };
}

/** 解析 iOS 退款问询（xpay_subscribe_ios_refund_query_notify）。 */
function parseIosRefundQuery(rawBody: string): IosRefundQueryNotification {
  const trimmed = rawBody.trim();
  if (trimmed.startsWith("{")) {
    const record = parseJsonRecord(trimmed);
    return {
      refundTimeSeconds: numberField(record, "refund_time"),
      channelBill: stringField(record, "channel_bill"),
      productId: stringField(record, "product_id"),
      count: numberField(record, "p_count"),
      refundRequestReason: stringField(record, "refund_request_reason"),
      provideStatus: numberField(record, "provide_status"),
      payOrderId: stringField(record, "pay_order_id"),
    };
  }
  return {
    refundTimeSeconds: readNumber(xmlValue(trimmed, "refund_time")),
    channelBill: xmlValue(trimmed, "channel_bill"),
    productId: xmlValue(trimmed, "product_id"),
    count: readNumber(xmlValue(trimmed, "p_count")),
    refundRequestReason: xmlValue(trimmed, "refund_request_reason"),
    provideStatus: readNumber(xmlValue(trimmed, "provide_status")),
    payOrderId: xmlValue(trimmed, "pay_order_id"),
  };
}

function parseJsonRecord(rawBody: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw invalidArgument("虚拟支付推送 JSON 格式不正确");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidArgument("虚拟支付推送格式不正确");
  }
  return parsed as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(source: Record<string, unknown>, key: string): number | null {
  return readNumber(source[key]);
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function objectField(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sendImage(
  response: ServerResponse,
  avatar: { readonly buffer: Buffer; readonly contentType: string },
  cacheControl = "public, max-age=31536000, immutable",
): void {
  response.statusCode = 200;
  response.setHeader("content-type", avatar.contentType);
  response.setHeader("content-length", avatar.buffer.length);
  response.setHeader("cache-control", cacheControl);
  response.setHeader("x-content-type-options", "nosniff");
  response.end(avatar.buffer);
}

function errorPayload(
  code: string,
  message: string,
  id: string,
  details: Readonly<Record<string, unknown>> = {},
  failure: AiPublicFailure | null = null,
): ErrorResponse {
  return {
    error: {
      code,
      message,
      ...(failure ? {
        category: failure.category,
        retryable: failure.retryable,
        action: failure.action,
      } : {}),
      requestId: id,
      details,
    },
  };
}

export type HttpApplication = (request: IncomingMessage, response: ServerResponse) => void;

export interface HttpApplicationDependencies {
  readonly database: DatabaseHealthProvider;
  readonly auth: AuthLoginService;
  readonly authenticator: RequestAuthenticator;
  readonly users: UserProfileService;
  readonly avatars: AvatarStorage;
  readonly avatarMaximumBytes: number;
  readonly files: FileAssetService;
  readonly covers: CoverStorage;
  readonly aiFiles: AiFileStorage;
  readonly works: PostgresWorkService;
  readonly quotaDownloads: PostgresQuotaDownloadService;
  readonly payments: PaymentService;
  readonly coverMaximumBytes: number;
  readonly aiFileMaximumBytes: number;
  readonly aiRateLimiter?: InMemoryRateLimiter;
  readonly aiGenerations: PostgresAiGenerationService;
  /** 作品标题保存前必须经过内容安全校验；缺失时应 fail closed */
  readonly contentSecurity: ContentSecurityService;
  readonly contentSecurityMediaMaximumBytes?: number;
  /**
   * 虚拟支付消息推送的凭据（MP 后台「消息推送配置」里填的 Token / EncodingAESKey）。
   * 缺失时握手会直接 503 —— 宁可让后台配置明着失败，也不要假装配好了却一条推送都收不到。
   */
  readonly virtualPayPush?: VirtualPayPushCredentials;
  readonly capabilities?: {
    readonly wechatPay: boolean;
    readonly aiGeneration: boolean;
    readonly persistentStorage: boolean;
    readonly httpsPublicUrls: boolean;
    readonly monitoringAlerts: boolean;
    readonly contentSecurity?: boolean;
  };
}

function sendText(response: ServerResponse, value: string): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(value);
}

function requireContentSecurity(dependencies: HttpApplicationDependencies): ContentSecurityService {
  if (!dependencies.contentSecurity) {
    throw new AppError(503, "CONTENT_SECURITY_NOT_CONFIGURED", "内容安全服务尚未配置");
  }
  return dependencies.contentSecurity;
}

function wechatPaymentHeaders(request: IncomingMessage): Readonly<Record<string, string | undefined>> {
  const names = [
    "wechatpay-timestamp",
    "wechatpay-nonce",
    "wechatpay-serial",
    "wechatpay-signature",
  ] as const;
  return Object.fromEntries(names.map((name) => {
    const value = request.headers[name];
    return [name, typeof value === "string" ? value : undefined];
  }));
}

function listOptions(url: URL, userId: string): { userId: string; status?: WorkStatus; page: number; pageSize: number; query?: string } {
  for (const key of url.searchParams.keys()) {
    if (!["status", "page", "pageSize", "query"].includes(key)) throw invalidArgument("作品列表包含不支持的查询参数");
    if (url.searchParams.getAll(key).length > 1) throw invalidArgument(`查询参数 ${key} 不能重复`);
  }
  const page = positiveQueryInteger(url.searchParams.get("page"), 1, 1_000_000, "page");
  const pageSize = positiveQueryInteger(url.searchParams.get("pageSize"), 20, 50, "pageSize");
  const statusValue = url.searchParams.get("status");
  if (statusValue !== null && statusValue !== "draft" && statusValue !== "completed") throw invalidArgument("status 只能是 draft 或 completed");
  const query = url.searchParams.get("query")?.trim() || undefined;
  if (query && Array.from(query).length > 120) throw invalidArgument("query 不能超过 120 个字符");
  return { userId, page, pageSize, ...(statusValue ? { status: statusValue } : {}), ...(query ? { query } : {}) };
}

function favoriteListOptions(url: URL, userId: string): FavoriteListOptions {
  for (const key of url.searchParams.keys()) {
    if (!["page", "pageSize", "query"].includes(key)) throw invalidArgument("收藏列表包含不支持的查询参数");
    if (url.searchParams.getAll(key).length > 1) throw invalidArgument(`查询参数 ${key} 不能重复`);
  }
  const page = positiveQueryInteger(url.searchParams.get("page"), 1, 1_000_000, "page");
  const pageSize = positiveQueryInteger(url.searchParams.get("pageSize"), 20, 50, "pageSize");
  const query = url.searchParams.get("query")?.trim() || undefined;
  if (query && Array.from(query).length > 120) throw invalidArgument("query 不能超过 120 个字符");
  return { userId, page, pageSize, ...(query ? { query } : {}) };
}

function downloadListOptions(url: URL, userId: string): DownloadListOptions {
  for (const key of url.searchParams.keys()) {
    if (!["fileType", "page", "pageSize", "query"].includes(key)) throw invalidArgument("下载记录列表包含不支持的查询参数");
    if (url.searchParams.getAll(key).length > 1) throw invalidArgument(`查询参数 ${key} 不能重复`);
  }
  const page = positiveQueryInteger(url.searchParams.get("page"), 1, 1_000_000, "page");
  const pageSize = positiveQueryInteger(url.searchParams.get("pageSize"), 20, 50, "pageSize");
  const fileType = url.searchParams.get("fileType");
  if (fileType !== null && fileType !== "preview" && fileType !== "chart" && fileType !== "materials" && fileType !== "palette") {
    throw invalidArgument("fileType 只能是 preview、chart、materials 或 palette");
  }
  const query = url.searchParams.get("query")?.trim() || undefined;
  if (query && Array.from(query).length > 120) throw invalidArgument("query 不能超过 120 个字符");
  return {
    userId,
    page,
    pageSize,
    ...(fileType ? { fileType } : {}),
    ...(query ? { query } : {}),
  };
}

function orderListOptions(url: URL, userId: string): OrderListOptions {
  for (const key of url.searchParams.keys()) {
    if (!["page", "pageSize"].includes(key)) throw invalidArgument("订单列表包含不支持的查询参数");
    if (url.searchParams.getAll(key).length > 1) throw invalidArgument(`查询参数 ${key} 不能重复`);
  }
  return {
    userId,
    page: positiveQueryInteger(url.searchParams.get("page"), 1, 1_000_000, "page"),
    pageSize: positiveQueryInteger(url.searchParams.get("pageSize"), 20, 50, "pageSize"),
  };
}

function positiveQueryInteger(value: string | null, fallback: number, maximum: number, name: string): number {
  if (value === null) return fallback;
  if (!/^[0-9]+$/u.test(value)) throw invalidArgument(`${name} 必须是整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw invalidArgument(`${name} 超出允许范围`);
  return parsed;
}

function workId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/works\/([^/]+)$/u);
  return match?.[1] ?? null;
}

function favoriteWorkId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/works\/([^/]+)\/favorite$/u);
  return match?.[1] ?? null;
}

function aiGenerationId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/ai\/generations\/([^/]+)$/u);
  return match?.[1] ?? null;
}

/** 订单页的支付订单操作路由：POST /api/payments/{orderId}/continue|cancel。 */
export interface PaymentOrderActionRoute {
  readonly orderId: string;
  readonly action: "continue" | "cancel";
}

/**
 * 解析支付订单操作路径。
 *
 * 精确匹配 continue/cancel 两个后缀，避免把 /api/payments/create、
 * /api/payments/notify 等既有固定路由误捕成 orderId。
 */
function paymentOrderAction(pathname: string): PaymentOrderActionRoute | null {
  const match = pathname.match(/^\/api\/payments\/([^/]+)\/(continue|cancel)$/u);
  if (!match?.[1] || !match[2]) return null;
  return { orderId: match[1], action: match[2] as PaymentOrderActionRoute["action"] };
}

function sendNoContent(response: ServerResponse): void {
  response.statusCode = 204;
  response.removeHeader("content-type");
  response.removeHeader("cache-control");
  response.end();
}

function hasRequestBody(request: IncomingMessage): boolean {
  const length = request.headers["content-length"];
  if (length !== undefined) return Number.parseInt(length, 10) > 0;
  return request.headers["transfer-encoding"] !== undefined;
}

export { requestId, sendJson, sendRaw, parseDeliveryNotification, parseEventName, parseRefundNotification, parseIosRefundQuery, sendImage, errorPayload, sendText, requireContentSecurity, wechatPaymentHeaders, listOptions, favoriteListOptions, downloadListOptions, orderListOptions, positiveQueryInteger, workId, favoriteWorkId, aiGenerationId, paymentOrderAction, sendNoContent, hasRequestBody };
