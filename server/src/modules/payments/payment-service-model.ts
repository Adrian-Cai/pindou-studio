import type { QueryResultRow } from "pg";
import { AppError, notFound } from "../../shared/app-error";
import { decryptOpenid } from "../../shared/identity";
import type { OrderItem, OrderStatus, PaymentPackage, PendingOrderReconcileSummary } from "./payment-service";
import type { QueriedVirtualOrder, VirtualOrderState } from "./virtual-pay-client";
export interface PackageRow extends QueryResultRow {
  readonly id: string;
  readonly label: string;
  readonly quota_amount: number;
  readonly quota_kind: string;
  readonly membership_type: string | null;
  readonly membership_days: number | null;
  readonly price_fen: number;
  readonly currency: string;
  readonly enabled: boolean;
  readonly virtual_product_id: string | null;
}

export interface OrderRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly package_id: string | null;
  readonly package_label_snapshot: string;
  readonly quota_amount_snapshot: number;
  readonly quota_kind_snapshot: string;
  readonly membership_type_snapshot: string | null;
  readonly price_fen: number;
  readonly status: string;
  readonly wx_prepay_id: string | null;
  readonly wx_transaction_id: string | null;
  readonly openid_ciphertext?: string | null;
  readonly paid_at?: Date | string | null;
  readonly created_at?: Date | string;
  readonly expires_at?: Date | string | null;
  readonly closed_at?: Date | string | null;
}

export interface UserPaymentRow extends QueryResultRow {
  readonly openid_ciphertext: string | null;
  readonly session_key_ciphertext: string | null;
}

export interface PaymentAttemptRow extends QueryResultRow {
  readonly id: string;
  readonly order_id: string;
  readonly user_id: string;
  readonly out_trade_no: string;
  readonly status: "ISSUED" | "SUCCEEDED" | "CLOSED" | "UNKNOWN";
  readonly wechat_transaction_id: string | null;
  readonly amount_fen: number;
  readonly created_at: Date | string;
  readonly paid_at: Date | string | null;
  readonly closed_at: Date | string | null;
  readonly order_status?: string;
}

export function packageResponse(row: PackageRow): PaymentPackage {
  if (
    row.currency !== "CNY"
    || row.enabled !== true
    || row.quota_kind !== "ai_generation"
    || row.membership_type !== null
    || row.membership_days !== null
    || !Number.isSafeInteger(row.quota_amount)
    || !Number.isSafeInteger(row.price_fen)
  ) {
    throw new Error("数据库套餐不符合支付业务约束");
  }
  return {
    id: row.id,
    label: row.label,
    quotaAmount: row.quota_amount,
    quotaKind: "ai_generation",
    membershipType: row.membership_type,
    priceFen: row.price_fen,
    currency: "CNY",
    enabled: true,
  };
}
export function orderStatus(value: string): OrderStatus {
  if (value === "pending" || value === "paid" || value === "failed" || value === "closed" || value === "refunded") {
    return value;
  }
  throw new Error("数据库订单状态不符合支付业务约束");
}

export function isoTimestamp(value: Date | string | undefined | null, field: string): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`数据库订单 ${field} 时间无效`);
  return date.toISOString();
}

export function orderResponse(row: OrderRow): OrderItem {
  const createdAt = isoTimestamp(row.created_at, "created_at");
  if (!createdAt
    || row.quota_kind_snapshot !== "ai_generation"
    || !row.id
    || (row.package_id !== null && typeof row.package_id !== "string")
    || typeof row.package_label_snapshot !== "string"
    || !row.package_label_snapshot
    || !Number.isSafeInteger(row.quota_amount_snapshot)
    || row.quota_amount_snapshot < 0
    || !Number.isSafeInteger(row.price_fen)
    || row.price_fen < 0) {
    throw new Error("数据库 AI 订单快照不符合订单列表约束");
  }
  return {
    id: row.id,
    packageId: row.package_id,
    packageLabel: row.package_label_snapshot,
    quotaAmount: row.quota_amount_snapshot,
    quotaKind: "ai_generation",
    priceFen: row.price_fen,
    currency: "CNY",
    status: orderStatus(row.status),
    createdAt,
    paidAt: isoTimestamp(row.paid_at, "paid_at"),
  };
}

/**
 * 校验套餐可否支付：必须是 CNY、价格与额度为正、且是 AI 生成次数（不支持会员类套餐）。
 *
 * 额外要求 virtual_product_id 非空 —— 虚拟支付靠它定位道具，
 * 缺失会在客户端报 -15010（道具未发布），而这个错误配置的人很难第一时间想到是套餐表没填。
 */
export function ensurePayablePackage(row: PackageRow | undefined): PackageRow {
  if (!row) throw notFound("套餐不存在或已下架");
  if (
    row.currency !== "CNY"
    || !Number.isSafeInteger(row.price_fen)
    || row.price_fen <= 0
    || !Number.isSafeInteger(row.quota_amount)
    || row.quota_amount <= 0
    || row.quota_kind !== "ai_generation"
    || row.membership_type !== null
    || row.membership_days !== null
  ) {
    throw new AppError(409, "PACKAGE_NOT_PAYABLE", "套餐当前不能通过微信支付购买");
  }
  if (!row.virtual_product_id) {
    throw new AppError(409, "PACKAGE_NOT_PAYABLE", "套餐未配置虚拟支付道具，请联系客服");
  }
  return row;
}

/** 补单候选行：只需用于定位订单与查单的最小字段集。 */
export interface ReconcileCandidateRow extends QueryResultRow {
  readonly id: string;
  readonly attempt_id: string;
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
  readonly openid_ciphertext: string | null;
  readonly out_trade_no: string;
}

/** 汇总里的可变累加器：对外返回时才冻结成 `PendingOrderReconcileSummary`。 */
export interface ReconcileCounter {
  scanned: number;
  granted: number;
  duplicate: number;
  unpaid: number;
  stalled: number;
  closed: number;
  unresolved: number;
  skipped: number;
  attention: string[];
}

export function emptyReconcileCounter(): ReconcileCounter {
  return {
    scanned: 0,
    granted: 0,
    duplicate: 0,
    unpaid: 0,
    stalled: 0,
    closed: 0,
    unresolved: 0,
    skipped: 0,
    attention: [],
  };
}

/** 兼容 pg 把 timestamptz 反序列化成 Date、也可能原样返回字符串的两种情况。 */
export function orderCreatedAtMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function queriedPaymentState(value: QueriedVirtualOrder): VirtualOrderState {
  if (value.state) return value.state;
  return value.paid ? "PAID" : "UNPAID";
}

/**
 * 解密付款人 openid，失败返回空串而不是抛错。
 *
 * 退款这类场景下「解不出身份」是**信息**而不是异常：调用方据此走「无法核验」分支并留痕，
 * 让整条链路继续跑完。抛错反而会让一次可诊断的事件退化成一次 500。
 */
export function decryptOpenidOrEmpty(ciphertext: string | null | undefined, secret: string): string {
  if (!ciphertext) return "";
  try {
    return decryptOpenid(ciphertext, secret);
  } catch {
    return "";
  }
}

export function freezeReconcileCounter(counter: ReconcileCounter): PendingOrderReconcileSummary {
  return {
    scanned: counter.scanned,
    granted: counter.granted,
    duplicate: counter.duplicate,
    unpaid: counter.unpaid,
    stalled: counter.stalled,
    closed: counter.closed,
    unresolved: counter.unresolved,
    skipped: counter.skipped,
    attention: [...counter.attention],
  };
}
