import type { Pool, PoolClient, QueryResultRow } from "pg";
import { AppError, idempotencyConflict, invalidArgument, notFound, unauthorized } from "../../shared/app-error";
import {
  createEntityId,
  createIdempotentOrderId,
  decryptOpenid,
} from "../../shared/identity";
import { rollbackTransaction } from "../../shared/transaction";
import type {
  PaymentNotificationInput,
  PaymentParameters,
  VerifiedPaymentNotification,
  WeChatPaymentGateway,
} from "./wechat-pay-client";

const NEW_USER_TEST_PACKAGE_ID = "ai_generation_new_user_5";

export interface PaymentPackage {
  readonly id: string;
  readonly label: string;
  readonly quotaAmount: number;
  readonly quotaKind: "ai_generation";
  readonly membershipType: string | null;
  readonly priceFen: number;
  readonly currency: "CNY";
  readonly enabled: true;
}

export interface CreatePaymentInput {
  readonly userId: string;
  readonly packageId: string;
  readonly idempotencyKey: string;
}

export interface CreatePaymentResponse {
  readonly orderId: string;
  readonly payment: PaymentParameters;
}

export type OrderStatus = "pending" | "paid" | "failed" | "closed" | "refunded";

export interface OrderListOptions {
  readonly userId: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface OrderItem {
  readonly id: string;
  readonly packageId: string | null;
  readonly packageLabel: string;
  readonly quotaAmount: number;
  readonly quotaKind: "ai_generation";
  readonly priceFen: number;
  readonly currency: "CNY";
  readonly status: OrderStatus;
  readonly createdAt: string;
  readonly paidAt: string | null;
}

export interface OrderListResponse {
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly items: readonly OrderItem[];
}

export interface PaymentService {
  listPackages(): Promise<{ readonly items: readonly PaymentPackage[] }>;
  listOrders(options: OrderListOptions): Promise<OrderListResponse>;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResponse>;
  handleNotification(input: PaymentNotificationInput): Promise<{ readonly duplicate: boolean }>;
}

interface PackageRow extends QueryResultRow {
  readonly id: string;
  readonly label: string;
  readonly quota_amount: number;
  readonly quota_kind: string;
  readonly membership_type: string | null;
  readonly membership_days: number | null;
  readonly price_fen: number;
  readonly currency: string;
  readonly enabled: boolean;
}

interface OrderRow extends QueryResultRow {
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
}

interface UserPaymentRow extends QueryResultRow {
  readonly openid_ciphertext: string | null;
}

function packageResponse(row: PackageRow): PaymentPackage {
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

function paymentDescription(label: string): string {
  return Array.from(`小露拼豆-${label}`).slice(0, 127).join("");
}

function orderStatus(value: string): OrderStatus {
  if (value === "pending" || value === "paid" || value === "failed" || value === "closed" || value === "refunded") {
    return value;
  }
  throw new Error("数据库订单状态不符合支付业务约束");
}

function isoTimestamp(value: Date | string | undefined | null, field: string): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`数据库订单 ${field} 时间无效`);
  return date.toISOString();
}

function orderResponse(row: OrderRow): OrderItem {
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

function ensurePayablePackage(row: PackageRow | undefined): PackageRow {
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
  return row;
}

function validateNotificationAgainstOrder(
  notification: VerifiedPaymentNotification,
  order: OrderRow,
  expectedMerchantId: string,
  expectedAppId: string,
  payerOpenid: string,
): void {
  if (notification.merchantId !== expectedMerchantId) {
    throw new AppError(400, "PAYMENT_MERCHANT_MISMATCH", "微信支付回调商户号不匹配");
  }
  if (notification.appId !== expectedAppId) {
    throw new AppError(400, "PAYMENT_APP_MISMATCH", "微信支付回调应用标识不匹配");
  }
  if (
    notification.orderId !== order.id
    || notification.amountFen !== order.price_fen
    || notification.currency !== "CNY"
  ) {
    throw new AppError(400, "PAYMENT_ORDER_MISMATCH", "微信支付回调订单或金额不匹配");
  }
  if (notification.payerOpenid !== payerOpenid) {
    throw new AppError(400, "PAYMENT_PAYER_MISMATCH", "微信支付回调付款人不匹配");
  }
}

export class PostgresPaymentService implements PaymentService {
  public constructor(
    private readonly pool: Pool,
    private readonly gateway: WeChatPaymentGateway,
    private readonly openidEncryptionSecret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async listPackages(): Promise<{ readonly items: readonly PaymentPackage[] }> {
    const result = await this.pool.query<PackageRow>(
      `SELECT id, label, quota_amount, quota_kind, membership_type, membership_days,
              price_fen, currency, enabled
         FROM pindou_packages
        WHERE enabled = TRUE
          AND quota_kind = 'ai_generation'
          AND membership_type IS NULL
          AND membership_days IS NULL
        ORDER BY sort_order, id`,
    );
    return { items: result.rows.map(packageResponse) };
  }

  public async listOrders(options: OrderListOptions): Promise<OrderListResponse> {
    const countResult = await this.pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
         FROM pindou_orders
        WHERE user_id = $1
          AND quota_kind_snapshot = 'ai_generation'`,
      [options.userId],
    );
    const result = await this.pool.query<OrderRow>(
      `SELECT id, package_id, package_label_snapshot, quota_amount_snapshot,
              quota_kind_snapshot, price_fen, status, created_at, paid_at
         FROM pindou_orders
        WHERE user_id = $1
          AND quota_kind_snapshot = 'ai_generation'
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [options.userId, options.pageSize, (options.page - 1) * options.pageSize],
    );
    return {
      total: countResult.rows[0]?.total ?? 0,
      page: options.page,
      pageSize: options.pageSize,
      items: result.rows.map(orderResponse),
    };
  }

  public async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResponse> {
    if (!this.gateway.configured) {
      throw new AppError(503, "PAYMENT_NOT_CONFIGURED", "微信支付尚未完成服务端配置");
    }
    const packageId = input.packageId.trim();
    if (!packageId || packageId.length > 40) throw invalidArgument("packageId 无效");
    const orderId = createIdempotentOrderId(input.userId, input.idempotencyKey);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `pindou-payment-user:${input.userId}`,
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `pindou-payment:${orderId}`,
      ]);
      const existingResult = await client.query<OrderRow>(
        `SELECT id, user_id, package_id, package_label_snapshot, quota_amount_snapshot,
                quota_kind_snapshot,
                membership_type_snapshot, price_fen, status, wx_prepay_id, wx_transaction_id
           FROM pindou_orders
          WHERE id = $1
          LIMIT 1
          FOR UPDATE`,
        [orderId],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.user_id !== input.userId || existing.package_id !== packageId) {
          throw idempotencyConflict("支付幂等键已用于另一份订单请求");
        }
        if (existing.status !== "pending") {
          throw new AppError(409, "ORDER_NOT_PAYABLE", "订单当前状态不能再次支付");
        }
        if (existing.wx_prepay_id) {
          await client.query("COMMIT");
          return { orderId, payment: this.gateway.paymentParameters(existing.wx_prepay_id) };
        }
      }

      const packageResult = await client.query<PackageRow>(
        `SELECT id, label, quota_amount, quota_kind, membership_type, membership_days,
                price_fen, currency, enabled
           FROM pindou_packages
          WHERE id = $1 AND enabled = TRUE
          LIMIT 1
          FOR SHARE`,
        [packageId],
      );
      const selectedPackage = ensurePayablePackage(packageResult.rows[0]);
      if (selectedPackage.id === NEW_USER_TEST_PACKAGE_ID) {
        const previousPurchase = await client.query(
          `SELECT 1
             FROM pindou_orders
            WHERE user_id = $1
              AND quota_kind_snapshot = 'ai_generation'
              AND status = 'paid'
            LIMIT 1
            FOR SHARE`,
          [input.userId],
        );
        if (previousPurchase.rows[0]) {
          throw new AppError(
            409,
            "NEW_USER_PACKAGE_NOT_ELIGIBLE",
            "新人测试福利仅限首次购买 AI 生成次数",
          );
        }
      }
      const userResult = await client.query<UserPaymentRow>(
        `SELECT openid_ciphertext
           FROM pindou_users
          WHERE id = $1 AND deleted_at IS NULL
          LIMIT 1
          FOR SHARE`,
        [input.userId],
      );
      const user = userResult.rows[0];
      if (!user) throw unauthorized("用户不存在或已失效");
      if (!user.openid_ciphertext) {
        throw new AppError(409, "PAYMENT_IDENTITY_UNAVAILABLE", "请重新登录后再发起支付");
      }
      let payerOpenid: string;
      try {
        payerOpenid = decryptOpenid(user.openid_ciphertext, this.openidEncryptionSecret);
      } catch {
        throw new AppError(409, "PAYMENT_IDENTITY_UNAVAILABLE", "支付身份不可用，请重新登录");
      }

      const currentTime = this.now();
      if (!existing) {
        await client.query(
          `INSERT INTO pindou_orders (
             id, user_id, package_id, package_label_snapshot, quota_amount_snapshot,
             quota_kind_snapshot,
             membership_type_snapshot, price_fen, status, wx_prepay_id,
             wx_transaction_id, paid_at, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NULL, NULL, NULL, $9, $9)`,
          [
            orderId,
            input.userId,
            selectedPackage.id,
            selectedPackage.label,
            selectedPackage.quota_amount,
            selectedPackage.quota_kind,
            selectedPackage.membership_type,
            selectedPackage.price_fen,
            currentTime,
          ],
        );
      }
      const created = await this.gateway.createPayment({
        orderId,
        description: paymentDescription(selectedPackage.label),
        amountFen: selectedPackage.price_fen,
        currency: "CNY",
        payerOpenid,
      });
      await client.query(
        `UPDATE pindou_orders
            SET wx_prepay_id = $2, updated_at = $3
          WHERE id = $1 AND status = 'pending' AND wx_prepay_id IS NULL`,
        [orderId, created.prepayId, currentTime],
      );
      await client.query("COMMIT");
      return { orderId, payment: created.payment };
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async handleNotification(input: PaymentNotificationInput): Promise<{ readonly duplicate: boolean }> {
    const notification = this.gateway.verifyNotification(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const orderResult = await client.query<OrderRow>(
        `SELECT orders.id, orders.user_id, orders.package_id,
                orders.package_label_snapshot, orders.quota_amount_snapshot,
                orders.quota_kind_snapshot,
                orders.membership_type_snapshot, orders.price_fen, orders.status,
                orders.wx_prepay_id, orders.wx_transaction_id,
                users.openid_ciphertext
           FROM pindou_orders orders
           JOIN pindou_users users ON users.id = orders.user_id
          WHERE orders.id = $1
          LIMIT 1
          FOR UPDATE OF orders`,
        [notification.orderId],
      );
      const order = orderResult.rows[0];
      if (!order) throw notFound("支付订单不存在");
      if (!order.openid_ciphertext) {
        throw new AppError(400, "PAYMENT_PAYER_MISMATCH", "订单缺少可验证的付款人身份");
      }
      let payerOpenid: string;
      try {
        payerOpenid = decryptOpenid(order.openid_ciphertext, this.openidEncryptionSecret);
      } catch {
        throw new AppError(400, "PAYMENT_PAYER_MISMATCH", "订单付款人身份无法验证");
      }
      validateNotificationAgainstOrder(
        notification,
        order,
        this.gateway.merchantId,
        this.gateway.appId,
        payerOpenid,
      );
      if (notification.eventType !== "TRANSACTION.SUCCESS" || notification.tradeState !== "SUCCESS") {
        throw new AppError(400, "PAYMENT_STATE_INVALID", "微信支付状态不是成功");
      }

      if (order.status === "paid") {
        if (order.wx_transaction_id !== notification.transactionId) {
          throw new AppError(409, "PAYMENT_TRANSACTION_MISMATCH", "订单已绑定另一微信支付交易号");
        }
        const grant = await client.query(
          `SELECT id
             FROM pindou_quota_transactions
             WHERE order_id = $1 AND type = 'purchase_grant'
               AND quota_kind = $2
            LIMIT 1`,
          [order.id, order.quota_kind_snapshot],
        );
        if (!grant.rows[0]) throw new Error("已支付订单缺少 purchase_grant 额度流水");
        await client.query("COMMIT");
        console.log(JSON.stringify({ event: "wechat_payment_notification_duplicate", orderId: order.id }));
        return { duplicate: true };
      }
      if (order.status !== "pending") {
        throw new AppError(409, "ORDER_NOT_PAYABLE", "订单当前状态不能确认支付");
      }
      if (order.quota_amount_snapshot <= 0) {
        throw new AppError(409, "ORDER_GRANT_INVALID", "订单额度快照无效");
      }
      if (order.quota_kind_snapshot !== "ai_generation") {
        throw new AppError(409, "ORDER_GRANT_INVALID", "订单额度类型快照无效");
      }

      const paidAt = notification.paidAt ?? this.now();
      await client.query(
        `UPDATE pindou_orders
            SET status = 'paid', wx_transaction_id = $2, paid_at = $3, updated_at = $3
          WHERE id = $1 AND status = 'pending'`,
        [order.id, notification.transactionId, paidAt],
      );
      const inserted = await client.query(
        `INSERT INTO pindou_quota_transactions (
           id, user_id, quota_kind, type, amount, source, bucket, quota_date, order_id,
           download_record_id, idempotency_key, note, created_at
         ) VALUES ($1, $2, $3, 'purchase_grant', $4, 'payment', 'purchased', NULL,
                   $5, NULL, $6, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          createEntityId("qt"),
          order.user_id,
          order.quota_kind_snapshot,
          order.quota_amount_snapshot,
          order.id,
          `payment:${order.id}`,
          `购买套餐：${order.package_label_snapshot}`.slice(0, 255),
          paidAt,
        ],
      );
      if (!inserted.rows[0]) throw new Error("订单 purchase_grant 额度流水幂等冲突");
      await client.query("COMMIT");
      console.log(JSON.stringify({
        event: "wechat_payment_granted",
        orderId: order.id,
        quotaKind: order.quota_kind_snapshot,
        quotaAmount: order.quota_amount_snapshot,
      }));
      return { duplicate: false };
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
