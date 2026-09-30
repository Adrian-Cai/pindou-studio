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
import type { PaymentNotificationInput, WeChatPaymentGateway } from "./wechat-pay-client";
import type { QueriedVirtualOrder, VirtualPayGateway, VirtualPaymentPayload } from "./virtual-pay-client";
import {
  decryptOpenidOrEmpty,
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
import {
  DEFAULT_RECONCILE_OPTIONS,
  type CancelOrderInput,
  type ContinuePaymentInput,
  type CreatePaymentInput,
  type CreatePaymentResponse,
  type OrderListOptions,
  type OrderListResponse,
  type PaymentPackage,
  type PaymentService,
  type PendingOrderReconcileOptions,
} from "./payment-service-contracts";
export { DEFAULT_RECONCILE_OPTIONS };
export type {
  CancelOrderInput,
  ContinuePaymentInput,
  CreatePaymentInput,
  CreatePaymentResponse,
  OrderItem,
  OrderListOptions,
  OrderListResponse,
  OrderStatus,
  PaymentPackage,
  PaymentService,
  PendingOrderReconcileOptions,
  PendingOrderReconcileSummary,
  RefundOutcome,
} from "./payment-service-contracts";
const NEW_USER_TEST_PACKAGE_ID = "ai_generation_new_user_5";
const PAYMENT_EXPIRY_MS = 5 * 60_000;
const MAX_PENDING_ORDERS = 5;

/** 订单页传入的 orderId 只做长度与空白净化：具体存在性/归属由数据库校验。 */
function normalizeOrderId(value: string): string {
  const orderId = value.trim();
  if (!orderId || orderId.length > 64) throw invalidArgument("orderId 无效");
  return orderId;
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
    // pending 计数**不筛 quota_kind**：createPayment 的 MAX_PENDING_ORDERS 上限
    // 统计的是该用户全部 pending 订单，两处口径必须一致，
    // 否则旧 download 订单会把页面显示成 4/5 而服务端按 5/5 拦截。
    const pendingResult = await this.pool.query<{ pending: number }>(
      `SELECT COUNT(*)::int AS pending
         FROM pindou_orders
        WHERE user_id = $1
          AND status = 'pending'`,
      [options.userId],
    );
    const result = await this.pool.query<OrderRow>(
      `SELECT id, package_id, package_label_snapshot, quota_amount_snapshot,
              quota_kind_snapshot, price_fen, status, created_at, expires_at, paid_at
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
      pendingCount: pendingResult.rows[0]?.pending ?? 0,
      serverTime: this.now().toISOString(),
      items: result.rows.map(orderResponse),
    };
  }

  private async reconcileExpiredOrders(userId: string): Promise<void> {
    const expiredOrders = await this.pool.query<{ readonly found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pindou_orders
          WHERE user_id = $1 AND status = 'pending' AND expires_at <= $2
       ) AS found`,
      [userId, this.now()],
    );
    if (expiredOrders.rows[0]?.found) await this.reconcilePendingOrders(userId);
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
    await this.reconcileExpiredOrders(input.userId);
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
   * 继续支付一笔 pending 订单（订单页「继续支付」入口）。
   *
   * 与 createPayment 复用同一条 resumeExistingPayment 收尾链路：
   * 微信仍在支付中 → 沿用原订单、原支付尝试、原商户单号重新签发；
   * 微信已关单且订单未过期 → 为**同一张订单**签发新尝试号；
   * 微信已支付 → 补发货并回答 ORDER_ALREADY_PAID；
   * 订单过期且确认未支付/已关 → 关闭订单并回答 ORDER_EXPIRED；状态未知则禁止重试并继续核实。
   *
   * 前置校验（归属、状态）在短事务里完成，网络查单放在锁外 ——
   * 拿着行锁等微信接口会把并发下单/查单全部堵死。
   */
  public async continuePayment(input: ContinuePaymentInput): Promise<CreatePaymentResponse> {
    if (!this.virtualPay.configured) {
      throw new AppError(503, "VIRTUAL_PAYMENT_NOT_CONFIGURED", "虚拟支付尚未完成服务端配置");
    }
    const orderId = normalizeOrderId(input.orderId);
    const existing = await this.loadPayableOrderForUser(input.userId, orderId);
    return this.resumeExistingPayment(orderId, existing);
  }

  /**
   * 加载一笔属于指定用户的 pending 订单及其最新支付尝试，供继续支付使用。
   *
   * 归属不符与订单不存在同样回答「订单不存在」：订单号对其他用户是敏感信息，
   * 不能让枚举请求区分「存在但不是你的」和「不存在」。
   */
  private async loadPayableOrderForUser(
    userId: string,
    orderId: string,
  ): Promise<{ readonly order: OrderRow; readonly attempt: PaymentAttemptRow; readonly openid: string; readonly sessionKey: string; readonly productId: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `pindou-payment:${orderId}`,
      ]);
      const orderResult = await client.query<OrderRow>(
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
      const order = orderResult.rows[0];
      if (!order || order.user_id !== userId) throw notFound("订单不存在");
      if (order.status === "paid") {
        throw new AppError(409, "ORDER_ALREADY_PAID", "订单已支付", { orderId: order.id });
      }
      if (order.status === "closed") {
        throw new AppError(409, "ORDER_EXPIRED", "订单已关闭，请重新下单");
      }
      if (order.status !== "pending") {
        throw new AppError(409, "ORDER_NOT_PAYABLE", "订单当前状态不能再次支付");
      }
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
      const userResult = await client.query<UserPaymentRow>(
        `SELECT openid_ciphertext, session_key_ciphertext
           FROM pindou_users
          WHERE id = $1 AND deleted_at IS NULL
          LIMIT 1
          FOR SHARE`,
        [userId],
      );
      const user = userResult.rows[0];
      if (!user) throw unauthorized("用户不存在或已失效");
      if (!user.openid_ciphertext) {
        throw new AppError(409, "PAYMENT_IDENTITY_UNAVAILABLE", "请重新登录后再发起支付");
      }
      let openid: string;
      try {
        openid = decryptOpenid(user.openid_ciphertext, this.openidEncryptionSecret);
      } catch {
        throw new AppError(409, "PAYMENT_IDENTITY_UNAVAILABLE", "支付身份不可用，请重新登录");
      }
      const sessionKey = decryptSessionKey(user.session_key_ciphertext, this.openidEncryptionSecret);
      if (!sessionKey) {
        throw new AppError(409, "VIRTUAL_PAYMENT_SESSION_EXPIRED", "登录状态已失效，请重新登录后支付");
      }
      const productId = await this.continueProductId(client, order.package_id);
      await client.query("COMMIT");
      return { order, attempt, openid, sessionKey, productId };
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 继续支付所需的虚拟支付道具 id。
   *
   * 刻意**不校验套餐 enabled**：继续支付针对的是已创建的订单，金额取支付尝试快照，
   * 套餐后续下架/改价都不应把用户的在途订单卡死；但道具缺失就真的没法签名了。
   */
  private async continueProductId(client: Pick<Pool, "query">, packageId: string | null): Promise<string> {
    if (!packageId) {
      throw new AppError(409, "PACKAGE_NOT_PAYABLE", "订单缺少套餐信息，无法继续支付");
    }
    const result = await client.query<Pick<PackageRow, "id" | "virtual_product_id">>(
      `SELECT id, virtual_product_id
         FROM pindou_packages
        WHERE id = $1
        LIMIT 1`,
      [packageId],
    );
    const productId = result.rows[0]?.virtual_product_id;
    if (!productId) {
      throw new AppError(409, "PACKAGE_NOT_PAYABLE", "套餐支付配置已变化，无法继续支付该订单");
    }
    return productId;
  }

  /**
   * 用户主动取消一笔 pending 订单。
   *
   * 三条铁律：
   * ① 先查微信再关单 —— 用户点取消时可能其实已支付成功（success 回调丢失），
   *    查到 PAID 必须照常发货并回答 ORDER_ALREADY_PAID，绝不能把已付订单关掉；
   * ② 查单失败不关单 —— 网络/5xx 时订单状态未知，回答 PAYMENT_STATUS_CONFIRMING，
   *    客户端展示「支付状态确认中」，留给发货轮询收尾；
   * ③ 虚拟支付没有商户侧关单接口，微信侧 UNPAID 时只能本地关闭；
   *    若用户仍在某个未关闭的支付面板里完成付款，迟到的发货推送会把
   *    closed 修正回 paid（confirmAndGrant 支持），钱和货都不丢。
   */
  public async cancelOrder(input: CancelOrderInput): Promise<{ readonly status: "closed" }> {
    const orderId = normalizeOrderId(input.orderId);
    const client = await this.pool.connect();
    let attempt: PaymentAttemptRow | null = null;
    let openid = "";
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `pindou-payment:${orderId}`,
      ]);
      const orderResult = await client.query<OrderRow>(
        `SELECT id, user_id, package_id, package_label_snapshot, quota_amount_snapshot,
                quota_kind_snapshot, membership_type_snapshot, price_fen, status,
                wx_prepay_id, wx_transaction_id, virtual_out_trade_no,
                created_at, expires_at, paid_at
           FROM pindou_orders
          WHERE id = $1
          LIMIT 1
          FOR UPDATE`,
        [orderId],
      );
      const order = orderResult.rows[0];
      if (!order || order.user_id !== input.userId) throw notFound("订单不存在");
      // 幂等：重复点击取消（或发货轮询已关单）直接按成功返回
      if (order.status === "closed") {
        await client.query("COMMIT");
        return { status: "closed" };
      }
      if (order.status === "paid") {
        throw new AppError(409, "ORDER_ALREADY_PAID", "订单已支付", { orderId: order.id });
      }
      if (order.status !== "pending") {
        throw new AppError(409, "ORDER_NOT_PAYABLE", "订单当前状态不能取消");
      }
      const attemptResult = await client.query<PaymentAttemptRow>(
        `SELECT id, order_id, user_id, out_trade_no, status, wechat_transaction_id,
                amount_fen, created_at, paid_at, closed_at
           FROM pindou_payment_attempts
          WHERE order_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [orderId],
      );
      attempt = attemptResult.rows[0] ?? null;
      if (attempt && order.user_id) {
        const userResult = await client.query<UserPaymentRow>(
          `SELECT openid_ciphertext
             FROM pindou_users
            WHERE id = $1 AND deleted_at IS NULL
            LIMIT 1`,
          [input.userId],
        );
        const ciphertext = userResult.rows[0]?.openid_ciphertext ?? null;
        openid = decryptOpenidOrEmpty(ciphertext, this.openidEncryptionSecret);
      }
      await client.query("COMMIT");
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }

    if (attempt) {
      if (!openid) {
        // 解不出付款人身份就无法向微信核实，宁可不动订单也不能盲关
        throw new AppError(409, "PAYMENT_STATUS_CONFIRMING", "支付状态确认中，请稍后重试");
      }
      let verified: QueriedVirtualOrder;
      try {
        verified = await this.virtualPay.queryOrder({ openid, outTradeNo: attempt.out_trade_no });
      } catch (error: unknown) {
        await this.updateAttemptQuery(attempt.id, "UNKNOWN", error instanceof Error ? error.message : String(error));
        throw new AppError(409, "PAYMENT_STATUS_CONFIRMING", "支付状态确认中，请稍后重试");
      }
      const state = queriedPaymentState(verified);
      if (state === "PAID") {
        await this.confirmAndGrant(orderId, {
          attemptId: attempt.id,
          mchOrderNo: verified.mchOrderNo,
          transactionId: verified.transactionId,
          actualPriceFen: verified.actualPriceFen,
          payerOpenid: openid,
          paidAt: verified.paidTimeSeconds ? new Date(verified.paidTimeSeconds * 1_000) : this.now(),
        });
        throw new AppError(409, "ORDER_ALREADY_PAID", "订单已支付", { orderId });
      }
      if (state === "REFUNDED") {
        // 退款推送还没被处理：状态滞后，交给发货轮询按退款链路收尾
        await this.updateAttemptQuery(attempt.id, "UNKNOWN", "cancel_refunded_state");
        throw new AppError(409, "PAYMENT_STATUS_CONFIRMING", "支付状态确认中，请稍后重试");
      }
      // UNPAID：本地关单 + 关闭尝试（迟到支付仍可经发货推送修正回 paid）
      // CLOSED：微信侧已关，把本地尝试同步成 CLOSED 保持「全关才关单」的不变式
      await this.updateAttemptQuery(attempt.id, "CLOSED", state === "UNPAID" ? "user_cancelled" : null);
    }

    const currentTime = this.now();
    const closed = await this.pool.query(
      `UPDATE pindou_orders
          SET status = 'closed', closed_at = $2, updated_at = $2
        WHERE id = $1 AND status = 'pending'`,
      [orderId, currentTime],
    );
    if (!closed.rowCount) {
      // 并发期间状态被改（继续支付成功发货等）：重读一次给出准确答案
      const reread = await this.pool.query<{ readonly status: string }>(
        `SELECT status FROM pindou_orders WHERE id = $1 LIMIT 1`,
        [orderId],
      );
      if (reread.rows[0]?.status === "paid") {
        throw new AppError(409, "ORDER_ALREADY_PAID", "订单已支付", { orderId });
      }
    }
    console.log(JSON.stringify({ event: "payment_order_cancelled", orderId, source: "user" }));
    return { status: "closed" };
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
      if (!await this.closeOrderIfAttemptsClosed(orderId, currentTime)) {
        throw new AppError(409, "PAYMENT_STATUS_CONFIRMING", "支付状态确认中，请稍后重试");
      }
      throw new AppError(409, "ORDER_EXPIRED", "订单支付已关闭，请重新下单");
    }
    if (state === "UNPAID") {
      if (!existing.order.expires_at || currentTime.getTime() < orderCreatedAtMs(existing.order.expires_at)) {
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
      await this.updateAttemptQuery(existing.attempt.id, "CLOSED", "expired_unpaid");
      await this.closeOrderIfAttemptsClosed(orderId, currentTime);
      throw new AppError(409, "ORDER_EXPIRED", "订单已过期，请重新下单");
    }
    await this.updateAttemptQuery(
      existing.attempt.id,
      "UNKNOWN",
      "unconfirmed_provider_status",
    );
    throw new AppError(409, "PAYMENT_STATUS_CONFIRMING", "支付状态确认中，请稍后重试");
  }

}
