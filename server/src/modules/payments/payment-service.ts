/**
 * 支付服务：套餐列表、订单列表、下单（虚拟支付）与发货到账。
 *
 * 职责：串联「订单表 + 虚拟支付网关 + 额度账本」；不负责协议签名细节（见 virtual-pay-client）。
 * 调用方：http 路由层的 /api/packages、/api/orders、/api/payments、/api/payments/notify。
 * 关键点：订单幂等键唯一、支付尝试号不可覆盖；同一用户创建由 advisory lock 串行化；
 *         **推送只是通知**，必须先经 query_order 反向验真才允许发放权益；
 *         发货有两条支路：推送（`handleDelivery`）负责实时，轮询（`reconcilePendingOrders`）
 *         负责兜住推送丢失 —— 官方要求两者至少实现一个，少了轮询等于默许「扣了款不到账」；
 *         到账只写一条 purchase_grant 额度流水（ON CONFLICT DO NOTHING），重复通知不会重复加额度；
 *         订单快照字段（package_label_snapshot 等）是下单瞬间的副本，套餐后续改价不影响历史订单。
 */
import type { Pool } from "pg";
import { AppError, idempotencyConflict, invalidArgument, notFound, unauthorized } from "../../shared/app-error";
import {
  createEntityId,
  createIdempotentOrderId,
  createVirtualOutTradeNo,
  decryptOpenid,
  decryptSessionKey,
} from "../../shared/identity";
import { rollbackTransaction } from "../../shared/transaction";
import type { PaymentNotificationInput, PaymentParameters, WeChatPaymentGateway } from "./wechat-pay-client";
import type {
  DeliveryNotification,
  IosRefundQueryAnswer,
  IosRefundQueryNotification,
  QueriedVirtualOrder,
  RefundNotification,
  VirtualOrderState,
  VirtualPayGateway,
  VirtualPaymentPayload,
} from "./virtual-pay-client";
import {
  ensurePayablePackage,
  orderCreatedAtMs,
  orderResponse,
  packageResponse,
  queriedPaymentState,
  type OrderRow,
  type PackageRow,
  type PaymentAttemptRow,
  type UserPaymentRow,
} from "./payment-service-model";
import { PaymentReconciliationService } from "./payment-reconciliation";
const NEW_USER_TEST_PACKAGE_ID = "ai_generation_new_user_5";
const PAYMENT_EXPIRY_MS = 5 * 60_000;
const MAX_PENDING_ORDERS = 5;

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

/**
 * 下单结果。
 *
 * virtual 里的 signData 使用一个不可变支付尝试号。已确认未支付时重用该尝试；
 * 只有微信明确关闭旧尝试后，才为同一业务订单签发新尝试号。
 */
export interface CreatePaymentResponse {
  readonly orderId: string;
  readonly virtual: VirtualPaymentPayload | null;
  /** 旧通道遗留字段：始终为 null，待旧回调链路下线后移除。 */
  readonly payment: PaymentParameters | null;
}

/** 订单状态机：pending 待支付 → paid 已支付 / failed 失败 / closed 已关闭，paid 后可 refunded。 */
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

/**
 * 虚拟支付发货补单（发货轮询）的调度参数。
 *
 * 官方要求「发货推送分支与发货轮询分支至少实现一个，两者结合使用体验更可靠」。
 * 本仓库两条都实现了：`handleDelivery` 被动等推送，本轮询主动捞漏网的。
 */
export interface PendingOrderReconcileOptions {
  /**
   * 下单后多久才纳入补单。
   *
   * 留出这段静默期是必要的：绝大多数发货推送在支付完成后几秒内到达，
   * 立刻轮询等于对每笔新订单多发一次注定查不出的请求，还要和用户正在进行的支付抢同一把行锁。
   */
  readonly graceMs: number;
  /**
   * pending 持续多久仍查不到已支付，就判为疑似漏发货并升级为告警。
   *
   * 这是「正常支付耗时」与「故障发现延迟」之间的权衡：太短会把还在犹豫的用户刷成告警，
   * 太长则让用户付完钱迟迟拿不到次数。
   */
  readonly staleAfterMs: number;
  /** 单轮最多处置多少笔。超出部分留到下一轮，避免积压集中爆发时长时间占用连接池。 */
  readonly batchSize: number;
}

export const DEFAULT_RECONCILE_OPTIONS: PendingOrderReconcileOptions = {
  graceMs: 3 * 60_000,
  staleAfterMs: 30 * 60_000,
  batchSize: 100,
};

/** 结构化日志里附带的订单号上限：告警要能一眼定位，但不能把日志刷成订单清单。 */
const RECONCILE_ATTENTION_LOG_LIMIT = 20;

/**
 * 退款处置结果。
 *
 * `clawedBack` 是**实际扣回的次数**，不是购买次数：虚拟商品一旦被消耗就收不回来，
 * 强行按整笔扣会把 `purchased` 打成负数，而额度读取会把负数钳成 0 ——
 * 表面上看着没问题，用户下次再买时新额度会被这个负余额悄悄吃掉。
 */
export interface RefundOutcome {
  /** 是否真的执行了退款（置为 refunded 且写入了扣回流水）。 */
  readonly applied: boolean;
  /** 本次实际扣回的额度次数。 */
  readonly clawedBack: number;
}

/** 补单汇总：既是返回值，也是结构化日志的主体。 */
export interface PendingOrderReconcileSummary {
  readonly scanned: number;
  /** 本轮补发成功的笔数 —— 非 0 说明发货推送确实丢过，需要回头查回调地址与事件订阅。 */
  readonly granted: number;
  /** 此前已发放、本轮只是再次确认的笔数（幂等命中）。 */
  readonly duplicate: number;
  /** 查单确认尚未支付、继续留在 pending 的笔数。 */
  readonly unpaid: number;
  /** 超过兜底窗口仍查不到支付、疑似发货链路故障的笔数。 */
  readonly stalled: number;
  /** 微信明确返回 CLOSED 且订单已过期、本轮被置为 closed 的笔数。 */
  readonly closed: number;
  /** 查单或发放本身抛错、本轮无法判定的笔数。 */
  readonly unresolved: number;
  /** 前置条件缺失（如拿不到付款人 openid）导致根本无法查单的笔数。 */
  readonly skipped: number;
  /** 需要人工介入的订单号（stalled / unresolved / skipped）。 */
  readonly attention: readonly string[];
}

export interface PaymentService {
  listPackages(): Promise<{ readonly items: readonly PaymentPackage[] }>;
  listOrders(options: OrderListOptions): Promise<OrderListResponse>;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResponse>;
  /** 处理虚拟支付发货推送：先验真再发货。 */
  handleDelivery(input: DeliveryNotification): Promise<{ readonly duplicate: boolean }>;
  /**
   * 发货轮询兜底：扫描超时未确认的 pending 订单，主动向微信查单，把漏发的权益补上。
   *
   * 与 `handleDelivery` 只有触发源不同：那里被动等推送，这里主动捞。
   * 两条路径最终都收敛到 `confirmAndGrant`，因此幂等与安全校验完全一致。
   */
  reconcilePendingOrders(): Promise<PendingOrderReconcileSummary>;
  /**
   * 处理退款推送：订单置 refunded，并扣回**尚未消耗**的购买额度。
   *
   * 注意这不是「支持退款」——退款是否发生由 Apple / 微信决定，我们只能事后知道。
   * 不接的后果是钱退给用户、虚拟商品却还留在他手里。
   */
  handleRefund(input: RefundNotification): Promise<RefundOutcome>;
  /**
   * 应答 iOS 退款问询：如实告诉 Apple 这笔虚拟商品到底发没发、消耗了多少。
   *
   * 3 秒内不应答，平台会向 Apple 回「不确定」，退款决定权就完全不在我们手上了。
   */
  answerIosRefundQuery(input: IosRefundQueryNotification): Promise<IosRefundQueryAnswer>;
  /** 旧通道回调兜底：仅用于收尾存量订单，确认无存量后可整体下线。 */
  handleNotification(input: PaymentNotificationInput): Promise<{ readonly duplicate: boolean }>;
}

export class PostgresPaymentService extends PaymentReconciliationService implements PaymentService {
  private readonly newUserPackageGateEnabled: boolean;

  public constructor(
    pool: Pool,
    virtualPay: VirtualPayGateway,
    legacyPay: WeChatPaymentGateway,
    openidEncryptionSecret: string,
    now: () => Date = () => new Date(),
    reconcileOptions: PendingOrderReconcileOptions = DEFAULT_RECONCILE_OPTIONS,
    newUserPackageGateEnabled = true,
  ) {
    super(pool, virtualPay, legacyPay, openidEncryptionSecret, now, reconcileOptions);
    this.newUserPackageGateEnabled = newUserPackageGateEnabled;
  }
  public async listPackages(): Promise<{ readonly items: readonly PaymentPackage[] }> {
    const result = await this.pool.query<PackageRow>(
      `SELECT id, label, quota_amount, quota_kind, membership_type, membership_days,
              price_fen, currency, enabled, virtual_product_id
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

  /**
   * 创建支付订单并签发虚拟支付参数。
   *
   * 与普通支付的差别：这里**不调用任何微信下单接口**。虚拟支付的下单在客户端
   * wx.requestVirtualPayment 内部完成，服务端只负责签名下发 signData / paySig / signature。
   *
   * @param input.idempotencyKey 客户端幂等键，与 userId 共同决定订单 id，重复提交返回同一订单
   * @throws VIRTUAL_PAYMENT_NOT_CONFIGURED 服务端未配置 OfferID/AppKey
   * @throws VIRTUAL_PAYMENT_SESSION_EXPIRED session_key 缺失或过期，需用户重新登录
   * @throws ORDER_NOT_PAYABLE 订单已不是 pending（已支付或已关闭）
   * @throws NEW_USER_PACKAGE_NOT_ELIGIBLE 新人套餐且用户已有成功购买记录
   *         （联调时可用 PAYMENT_NEW_USER_GATE_ENABLED=false 关掉这道限制）
   * @throws PAYMENT_IDENTITY_UNAVAILABLE 用户 openid 缺失或解密失败，需重新登录
   */
  public async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResponse> {
    if (!this.virtualPay.configured) {
      throw new AppError(503, "VIRTUAL_PAYMENT_NOT_CONFIGURED", "虚拟支付尚未完成服务端配置");
    }
    const packageId = input.packageId.trim();
    if (!packageId || packageId.length > 40) throw invalidArgument("packageId 无效");
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 128) throw invalidArgument("idempotencyKey 无效");
    const orderId = createIdempotentOrderId(input.userId, idempotencyKey);
    const expiredOrders = await this.pool.query<{ readonly found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pindou_orders
          WHERE user_id = $1 AND status = 'pending' AND expires_at <= $2
       ) AS found`,
      [input.userId, this.now()],
    );
    if (expiredOrders.rows[0]?.found) await this.reconcilePendingOrders(input.userId);
    const client = await this.pool.connect();
    let existing: { readonly order: OrderRow; readonly attempt: PaymentAttemptRow; readonly openid: string; readonly sessionKey: string; readonly productId: string } | null = null;
    let created: CreatePaymentResponse | null = null;
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
                membership_type_snapshot, price_fen, status, wx_prepay_id, wx_transaction_id,
                virtual_out_trade_no, created_at, expires_at, paid_at
           FROM pindou_orders
          WHERE id = $1
          LIMIT 1
          FOR UPDATE`,
        [orderId],
      );
      const existingOrder = existingResult.rows[0];
      if (existingOrder) {
        if (existingOrder.user_id !== input.userId || existingOrder.package_id !== packageId) {
          throw idempotencyConflict("支付幂等键已用于另一份订单请求");
        }
        if (existingOrder.status === "paid") {
          throw new AppError(409, "ORDER_ALREADY_PAID", "订单已支付", { orderId: existingOrder.id });
        }
        if (existingOrder.status === "closed") {
          throw new AppError(409, "ORDER_EXPIRED", "订单已关闭，请重新下单");
        }
        if (existingOrder.status !== "pending") {
          throw new AppError(409, "ORDER_NOT_PAYABLE", "订单当前状态不能再次支付");
        }
      }

      const packageResult = await client.query<PackageRow>(
        `SELECT id, label, quota_amount, quota_kind, membership_type, membership_days,
                price_fen, currency, enabled, virtual_product_id
           FROM pindou_packages
          WHERE id = $1 AND enabled = TRUE
          LIMIT 1
          FOR SHARE`,
        [packageId],
      );
      const selectedPackage = ensurePayablePackage(packageResult.rows[0]);
      if (selectedPackage.id === NEW_USER_TEST_PACKAGE_ID && this.newUserPackageGateEnabled) {
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
        `SELECT openid_ciphertext, session_key_ciphertext
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
      const sessionKey = decryptSessionKey(user.session_key_ciphertext, this.openidEncryptionSecret);
      if (!sessionKey) {
        throw new AppError(409, "VIRTUAL_PAYMENT_SESSION_EXPIRED", "登录状态已失效，请重新登录后支付");
      }

      const currentTime = this.now();
      if (!existingOrder) {
        const pendingResult = await client.query<{ readonly total: number }>(
          `SELECT COUNT(*)::int AS total
             FROM pindou_orders
            WHERE user_id = $1 AND status = 'pending'`,
          [input.userId],
        );
        if ((pendingResult.rows[0]?.total ?? 0) >= MAX_PENDING_ORDERS) {
          throw new AppError(409, "MAX_PENDING_ORDERS_REACHED", "你已有 5 个待支付订单，请完成支付或等待订单关闭后再试");
        }
        const outTradeNo = createVirtualOutTradeNo();
        const attemptId = createEntityId("pa");
        const expiresAt = new Date(currentTime.getTime() + PAYMENT_EXPIRY_MS);
        await client.query(
          `INSERT INTO pindou_orders (
             id, user_id, package_id, package_label_snapshot, quota_amount_snapshot,
             quota_kind_snapshot,
             membership_type_snapshot, price_fen, status, wx_prepay_id,
             wx_transaction_id, virtual_out_trade_no, idempotency_key, expires_at,
             paid_at, closed_at, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NULL, NULL, $9, $10, $11, NULL, NULL, $12, $12)`,
          [
            orderId,
            input.userId,
            selectedPackage.id,
            selectedPackage.label,
            selectedPackage.quota_amount,
            selectedPackage.quota_kind,
            selectedPackage.membership_type,
            selectedPackage.price_fen,
            outTradeNo,
            idempotencyKey,
            expiresAt,
            currentTime,
          ],
        );
        await client.query(
          `INSERT INTO pindou_payment_attempts (
             id, order_id, user_id, out_trade_no, status, amount_fen, currency,
             created_at, issued_at
           ) VALUES ($1, $2, $3, $4, 'ISSUED', $5, 'CNY', $6, $6)`,
          [attemptId, orderId, input.userId, outTradeNo, selectedPackage.price_fen, currentTime],
        );
        created = {
          orderId,
          payment: null,
          virtual: this.virtualPay.createPayment({
            outTradeNo,
            productId: selectedPackage.virtual_product_id ?? "",
            goodsPriceFen: selectedPackage.price_fen,
            buyQuantity: 1,
            attach: orderId,
            sessionKey,
          }),
        };
      } else {
        const attemptResult = await client.query<PaymentAttemptRow>(
          `SELECT id, order_id, user_id, out_trade_no, status, wechat_transaction_id,
                  amount_fen, created_at, paid_at, closed_at
             FROM pindou_payment_attempts
            WHERE order_id = $1
            ORDER BY created_at DESC, id DESC
            LIMIT 1`,
          [orderId],
        );
        const attempt = attemptResult.rows[0];
        if (!attempt) throw new AppError(409, "PAYMENT_STATUS_CONFIRMING", "支付状态确认中，请稍后重试");
        existing = {
          order: existingOrder,
          attempt,
          openid: payerOpenid,
          sessionKey,
          productId: selectedPackage.virtual_product_id ?? "",
        };
      }
      await client.query("COMMIT");
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
    if (created) return created;
    if (!existing) throw new Error("支付订单未生成");
    return this.resumeExistingPayment(orderId, existing);
  }

  /**
   * 签发虚拟支付参数。
   *
   * session_key 在事务外读取是因为它只用于签名、不参与订单一致性；
   * 拿不到（未登录过新版 / 密文损坏）时必须给出可执行的提示，而不是笼统的「支付失败」。
   */
  private signVirtualPayment(input: {
    orderId: string;
    outTradeNo: string;
    productId: string;
    goodsPriceFen: number;
    sessionKey: string;
  }): VirtualPaymentPayload {
    return this.virtualPay.createPayment({
      outTradeNo: input.outTradeNo,
      productId: input.productId,
      goodsPriceFen: input.goodsPriceFen,
      buyQuantity: 1,
      attach: input.orderId,
      sessionKey: input.sessionKey,
    });
  }

  private async resumeExistingPayment(
    orderId: string,
    existing: { readonly order: OrderRow; readonly attempt: PaymentAttemptRow; readonly openid: string; readonly sessionKey: string; readonly productId: string },
  ): Promise<CreatePaymentResponse> {
    let verified: QueriedVirtualOrder;
    try {
      verified = await this.virtualPay.queryOrder({ openid: existing.openid, outTradeNo: existing.attempt.out_trade_no });
    } catch (error: unknown) {
      await this.updateAttemptQuery(existing.attempt.id, "UNKNOWN", error instanceof Error ? error.message : String(error));
      throw new AppError(409, "PAYMENT_STATUS_CONFIRMING", "支付状态确认中，请稍后重试");
    }
    const state = queriedPaymentState(verified);
    const currentTime = this.now();
    if (state === "PAID") {
      await this.confirmAndGrant(orderId, {
        attemptId: existing.attempt.id,
        mchOrderNo: verified.mchOrderNo,
        transactionId: verified.transactionId,
        actualPriceFen: verified.actualPriceFen,
        payerOpenid: existing.openid,
        paidAt: verified.paidTimeSeconds ? new Date(verified.paidTimeSeconds * 1_000) : currentTime,
      });
      throw new AppError(409, "ORDER_ALREADY_PAID", "订单已支付", { orderId });
    }
    if (state === "CLOSED") {
      await this.updateAttemptQuery(existing.attempt.id, "CLOSED", null);
      if (existing.order.expires_at && currentTime.getTime() >= orderCreatedAtMs(existing.order.expires_at)) {
        if (await this.closeOrderIfAttemptsClosed(orderId, currentTime)) {
          throw new AppError(409, "ORDER_EXPIRED", "订单已关闭，请重新下单");
        }
        throw new AppError(409, "PAYMENT_STATUS_CONFIRMING", "支付状态确认中，请稍后重试");
      }
      return this.createRetryAttempt(orderId, existing, currentTime);
    }
    if (state === "UNPAID" && (!existing.order.expires_at || currentTime.getTime() < orderCreatedAtMs(existing.order.expires_at))) {
      await this.updateAttemptQuery(existing.attempt.id, "ISSUED", null);
      return {
        orderId,
        payment: null,
        virtual: this.signVirtualPayment({
          orderId,
          outTradeNo: existing.attempt.out_trade_no,
          productId: existing.productId,
          goodsPriceFen: existing.attempt.amount_fen,
          sessionKey: existing.sessionKey,
        }),
      };
    }
    await this.updateAttemptQuery(
      existing.attempt.id,
      "UNKNOWN",
      state === "UNPAID" ? "expired_unpaid" : "unconfirmed_provider_status",
    );
    throw new AppError(409, "PAYMENT_STATUS_CONFIRMING", "支付状态确认中，请稍后重试");
  }

  private async createRetryAttempt(
    orderId: string,
    existing: { readonly order: OrderRow; readonly attempt: PaymentAttemptRow; readonly openid: string; readonly sessionKey: string; readonly productId: string },
    currentTime: Date,
  ): Promise<CreatePaymentResponse> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `pindou-payment-user:${existing.order.user_id}`,
      ]);
      const orderResult = await client.query<OrderRow>(
        `SELECT id, user_id, package_id, package_label_snapshot, quota_amount_snapshot,
                quota_kind_snapshot, membership_type_snapshot, price_fen, status,
                virtual_out_trade_no, created_at, expires_at, paid_at
           FROM pindou_orders WHERE id = $1 LIMIT 1 FOR UPDATE`,
        [orderId],
      );
      const order = orderResult.rows[0];
      if (!order || order.status !== "pending" || !order.expires_at || currentTime.getTime() >= orderCreatedAtMs(order.expires_at)) {
        throw new AppError(409, "ORDER_EXPIRED", "订单已关闭，请重新下单");
      }
      const latestResult = await client.query<PaymentAttemptRow>(
        `SELECT id, order_id, user_id, out_trade_no, status, wechat_transaction_id,
                amount_fen, created_at, paid_at, closed_at
           FROM pindou_payment_attempts
          WHERE order_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`,
        [orderId],
      );
      const latest = latestResult.rows[0];
      if (!latest || latest.id !== existing.attempt.id || latest.status !== "CLOSED") {
        throw new AppError(409, "PAYMENT_STATUS_CONFIRMING", "支付状态确认中，请稍后重试");
      }
      const outTradeNo = createVirtualOutTradeNo();
      const attemptId = createEntityId("pa");
      await client.query(
        `INSERT INTO pindou_payment_attempts (
           id, order_id, user_id, out_trade_no, status, amount_fen, currency, created_at, issued_at
         ) VALUES ($1, $2, $3, $4, 'ISSUED', $5, 'CNY', $6, $6)`,
        [attemptId, orderId, existing.order.user_id, outTradeNo, existing.attempt.amount_fen, currentTime],
      );
      await client.query(
        `UPDATE pindou_orders SET virtual_out_trade_no = $2, updated_at = $3
          WHERE id = $1 AND status = 'pending'`,
        [orderId, outTradeNo, currentTime],
      );
      const virtual = this.signVirtualPayment({
        orderId,
        outTradeNo,
        productId: existing.productId,
        goodsPriceFen: existing.attempt.amount_fen,
        sessionKey: existing.sessionKey,
      });
      await client.query("COMMIT");
      return { orderId, payment: null, virtual };
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }


}
