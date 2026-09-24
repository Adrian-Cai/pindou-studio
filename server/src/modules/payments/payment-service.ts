/**
 * 支付服务：套餐列表、订单列表、下单（虚拟支付）与发货到账。
 *
 * 职责：串联「订单表 + 虚拟支付网关 + 额度账本」；不负责协议签名细节（见 virtual-pay-client）。
 * 调用方：http 路由层的 /api/packages、/api/orders、/api/payments、/api/payments/notify。
 * 关键点：订单 id 由 userId + idempotencyKey 推导，重复下单天然幂等；
 *         下单用两级 advisory lock（用户级 + 订单级）串行化，避免同一用户并发建单；
 *         **发货推送无签名不可信**，必须先经 query_order 反向验真才允许发放权益；
 *         发货有两条支路：推送（`handleDelivery`）负责实时，轮询（`reconcilePendingOrders`）
 *         负责兜住推送丢失 —— 官方要求两者至少实现一个，少了轮询等于默许「扣了款不到账」；
 *         到账只写一条 purchase_grant 额度流水（ON CONFLICT DO NOTHING），重复通知不会重复加额度；
 *         订单快照字段（package_label_snapshot 等）是下单瞬间的副本，套餐后续改价不影响历史订单。
 */
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { AppError, idempotencyConflict, invalidArgument, notFound, unauthorized } from "../../shared/app-error";
import {
  createEntityId,
  createIdempotentOrderId,
  decryptOpenid,
  decryptSessionKey,
} from "../../shared/identity";
import { rollbackTransaction } from "../../shared/transaction";
import { shanghaiDate } from "../../shared/shanghai-time";
import { lockQuotaUser, readQuota } from "../quota/quota-ledger";
import type { PaymentNotificationInput, PaymentParameters, WeChatPaymentGateway } from "./wechat-pay-client";
import type {
  DeliveryNotification,
  IosRefundQueryAnswer,
  IosRefundQueryNotification,
  RefundNotification,
  VirtualPayGateway,
  VirtualPaymentPayload,
} from "./virtual-pay-client";

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

/**
 * 下单结果。
 *
 * virtual 为 null 表示该订单此前已由同一幂等键创建过 —— 虚拟支付的 signData 里含
 * 不可重复的 outTradeNo，每次必须重新签发，因此这里不留旧值，强制调用方重新取参。
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
  /**
   * pending 持续多久且**查单明确未支付**，就把订单置为 closed 并停止扫描。
   *
   * 与 staleAfterMs 的分工：那一个只告警、不动数据；这一个真的关单。
   * 关单不可逆（closed 之后迟到的发货推送只会拿到 ORDER_NOT_PAYABLE），
   * 因此这个窗口必须明显大于告警窗口，默认 1 小时。
   */
  readonly closeAfterMs: number;
  /** 单轮最多处置多少笔。超出部分留到下一轮，避免积压集中爆发时长时间占用连接池。 */
  readonly batchSize: number;
}

export const DEFAULT_RECONCILE_OPTIONS: PendingOrderReconcileOptions = {
  graceMs: 3 * 60_000,
  staleAfterMs: 30 * 60_000,
  closeAfterMs: 60 * 60_000,
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
  /** 超过关单窗口且查单确认未支付、本轮被置为 closed 的笔数。 */
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
  readonly virtual_product_id: string | null;
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

/**
 * 校验套餐可否支付：必须是 CNY、价格与额度为正、且是 AI 生成次数（不支持会员类套餐）。
 *
 * 额外要求 virtual_product_id 非空 —— 虚拟支付靠它定位道具，
 * 缺失会在客户端报 -15010（道具未发布），而这个错误配置的人很难第一时间想到是套餐表没填。
 */
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
  if (!row.virtual_product_id) {
    throw new AppError(409, "PACKAGE_NOT_PAYABLE", "套餐未配置虚拟支付道具，请联系客服");
  }
  return row;
}

/** 补单候选行：只需用于定位订单与查单的最小字段集。 */
interface ReconcileCandidateRow extends QueryResultRow {
  readonly id: string;
  readonly created_at: Date | string;
  readonly openid_ciphertext: string | null;
}

/** 汇总里的可变累加器：对外返回时才冻结成 `PendingOrderReconcileSummary`。 */
interface ReconcileCounter {
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

function emptyReconcileCounter(): ReconcileCounter {
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
function orderCreatedAtMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * 解密付款人 openid，失败返回空串而不是抛错。
 *
 * 退款这类场景下「解不出身份」是**信息**而不是异常：调用方据此走「无法核验」分支并留痕，
 * 让整条链路继续跑完。抛错反而会让一次可诊断的事件退化成一次 500。
 */
function decryptOpenidOrEmpty(ciphertext: string | null | undefined, secret: string): string {
  if (!ciphertext) return "";
  try {
    return decryptOpenid(ciphertext, secret);
  } catch {
    return "";
  }
}

function freezeReconcileCounter(counter: ReconcileCounter): PendingOrderReconcileSummary {
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

export class PostgresPaymentService implements PaymentService {
  public constructor(
    private readonly pool: Pool,
    private readonly virtualPay: VirtualPayGateway,
    private readonly legacyPay: WeChatPaymentGateway,
    private readonly openidEncryptionSecret: string,
    private readonly now: () => Date = () => new Date(),
    private readonly reconcileOptions: PendingOrderReconcileOptions = DEFAULT_RECONCILE_OPTIONS,
    /**
     * 新人测试套餐的「每人限购一次」是否生效，默认生效。
     * 联调时置 false 可让同一账号反复购买（详见 env.ts 的 PAYMENT_NEW_USER_GATE_ENABLED）。
     */
    private readonly newUserPackageGateEnabled: boolean = true,
  ) {}

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

    /**
     * 订单 id 直接复用订单号作为 outTradeNo。
     *
     * 虚拟支付限制 outTradeNo 为 8-32 位、仅数字字母与 _ - | * @、不以 _ 开头。
     * 现有 `order_` + 26 位十六进制正好 32 位且字符集合规，因此无需另建映射字段，
     * 发货回调里的 OutTradeNo 可以直接拿来回查订单 —— 少一层映射就少一处不一致。
     */
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
      await client.query("COMMIT");

      return {
        orderId,
        payment: null,
        virtual: await this.signVirtualPayment({
          orderId,
          productId: selectedPackage.virtual_product_id ?? "",
          goodsPriceFen: selectedPackage.price_fen,
          openid: payerOpenid,
          userId: input.userId,
        }),
      };
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 签发虚拟支付参数。
   *
   * session_key 在事务外读取是因为它只用于签名、不参与订单一致性；
   * 拿不到（未登录过新版 / 密文损坏）时必须给出可执行的提示，而不是笼统的「支付失败」。
   */
  private async signVirtualPayment(input: {
    orderId: string;
    productId: string;
    goodsPriceFen: number;
    openid: string;
    userId: string;
  }): Promise<VirtualPaymentPayload> {
    const result = await this.pool.query<{ readonly session_key_ciphertext: string | null }>(
      "SELECT session_key_ciphertext FROM pindou_users WHERE id = $1 LIMIT 1",
      [input.userId],
    );
    const sessionKey = decryptSessionKey(
      result.rows[0]?.session_key_ciphertext,
      this.openidEncryptionSecret,
    );
    if (!sessionKey) {
      throw new AppError(409, "VIRTUAL_PAYMENT_SESSION_EXPIRED", "登录状态已失效，请重新登录后支付");
    }
    return this.virtualPay.createPayment({
      orderId: input.orderId,
      productId: input.productId,
      // 道具单价必须与 MP 后台定价一致，否则客户端报 -15013
      goodsPriceFen: input.goodsPriceFen,
      buyQuantity: 1,
      attach: input.orderId,
      sessionKey,
    });
  }

  /**
   * 发货轮询兜底：把「已付款但发货推送没到」的订单补上额度。
   *
   * 为什么必须有这一层：`wx.requestVirtualPayment` 的 success 回调会丢失（微信异常退出），
   * 发货推送也只重试有限次数，任何一次丢失的结果都是**用户钱扣了、次数没到账，
   * 而系统里连一条告警都没有**。官方因此把轮询列为与推送并列的必选支路，而非可选优化。
   *
   * @returns 本轮处置汇总；结构化日志在本方法内已落地，调用方只需处理返回值
   */
  public async reconcilePendingOrders(): Promise<PendingOrderReconcileSummary> {
    const counter = emptyReconcileCounter();
    // 网关未配置时压根不存在虚拟支付订单，扫一遍只会空转并打出误导性的日志
    if (!this.virtualPay.configured) return freezeReconcileCounter(counter);

    const currentTime = this.now();
    /**
     * 候选筛选的三个条件各有用途：
     * - `created_at <= now - graceMs`：跳过刚刚下单的订单，给发货推送留出正常到达的时间；
     * - JOIN pindou_packages 且 `virtual_product_id IS NOT NULL`：**把订单限定在虚拟支付范围内**。
     *   旧通道（商户号 + APIv3）的在途订单由 /api/payments/notify 收尾，拿去 query_order
     *   只会得到「单号不存在」，徒增一批必然失败的告警；
     * - ORDER BY created_at ASC + LIMIT：先处理积压最久的，单轮工作量有上限。
     *
     * 刻意**不按 quota_kind_snapshot 过滤**：将来若把下载次数也走虚拟支付，
     * 这里会静默漏掉，而「套餐是否配了虚拟道具」才是唯一稳定的判据。
     */
    const result = await this.pool.query<ReconcileCandidateRow>(
      `SELECT orders.id, orders.created_at, users.openid_ciphertext
         FROM pindou_orders orders
         JOIN pindou_users users ON users.id = orders.user_id
         JOIN pindou_packages packages ON packages.id = orders.package_id
        WHERE orders.status = 'pending'
          AND orders.created_at <= $1
          AND packages.virtual_product_id IS NOT NULL
        ORDER BY orders.created_at ASC
        LIMIT $2`,
      [new Date(currentTime.getTime() - this.reconcileOptions.graceMs), this.reconcileOptions.batchSize],
    );

    for (const candidate of result.rows) {
      counter.scanned += 1;
      try {
        await this.reconcilePendingOrder(candidate, currentTime, counter);
      } catch (error: unknown) {
        // 单笔意外抛错不能中断整轮：后面的订单同样可能是真实漏发货，跳过等于放弃追款。
        counter.unresolved += 1;
        counter.attention.push(candidate.id);
        console.error(JSON.stringify({
          event: "virtual_payment_reconcile_alert",
          reason: "unexpected_failure",
          orderId: candidate.id,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    const summary = freezeReconcileCounter(counter);
    console.log(JSON.stringify({
      event: "virtual_payment_reconcile",
      scanned: summary.scanned,
      granted: summary.granted,
      duplicate: summary.duplicate,
      unpaid: summary.unpaid,
      stalled: summary.stalled,
      closed: summary.closed,
      unresolved: summary.unresolved,
      skipped: summary.skipped,
      attentionCount: summary.attention.length,
      attention: summary.attention.slice(0, RECONCILE_ATTENTION_LOG_LIMIT),
    }));
    return summary;
  }

  /**
   * 处置单笔候选订单：查单 → 确认已付则补发，否则按年龄判定是否该告警。
   *
   * unresolved / stalled / skipped 三种结局的共同点是**用户可能已经付了钱、而系统无法自证**，
   * 因此一律进 attention。这里的取舍：宁可多报一次人工核查，也不放过一个真实的漏发货。
   */
  private async reconcilePendingOrder(
    candidate: ReconcileCandidateRow,
    currentTime: Date,
    counter: ReconcileCounter,
  ): Promise<void> {
    let openid = "";
    try {
      openid = candidate.openid_ciphertext
        ? decryptOpenid(candidate.openid_ciphertext, this.openidEncryptionSecret)
        : "";
    } catch {
      openid = "";
    }
    if (!openid) {
      counter.skipped += 1;
      counter.attention.push(candidate.id);
      console.error(JSON.stringify({
        event: "virtual_payment_reconcile_alert",
        reason: "payer_identity_unavailable",
        orderId: candidate.id,
      }));
      return;
    }

    try {
      const verified = await this.virtualPay.queryOrder({ openid, orderId: candidate.id });
      if (!verified.paid) {
        const ageMs = currentTime.getTime() - orderCreatedAtMs(candidate.created_at);
        /**
         * 过了关单窗口 + 查单明确未支付 = 用户下单后放弃了付款。
         *
         * 这类订单必须有个终点：pending 是补单轮询的扫描条件，放着不管它会被
         * **每一轮**判成 stalled 并记一条「需要人工介入」的告警，
         * 几十笔未付款的单就能把真正的漏发货告警彻底淹没。
         *
         * 之所以要等满 closeAfterMs（默认 1 小时，远大于 30 分钟的告警窗口）才关，
         * 是因为关单不可逆：closed 之后迟到的发货推送只会拿到 ORDER_NOT_PAYABLE。
         * 先告警一阵、再关单，中间留给人发现「其实付了钱但查单异常」的余地。
         */
        if (ageMs >= this.reconcileOptions.closeAfterMs) {
          await this.closeStaleOrder(candidate.id, ageMs, currentTime, counter);
          return;
        }
        // 没过兜底窗口的，多半只是用户还没付完 / 支付结果尚未对可见，下一轮再看
        if (ageMs >= this.reconcileOptions.staleAfterMs) {
          counter.stalled += 1;
          counter.attention.push(candidate.id);
          console.error(JSON.stringify({
            event: "virtual_payment_reconcile_alert",
            reason: "pending_too_long",
            orderId: candidate.id,
            ageMs,
          }));
          return;
        }
        counter.unpaid += 1;
        return;
      }
      const outcome = await this.confirmAndGrant(candidate.id, {
        mchOrderNo: verified.mchOrderNo,
        transactionId: verified.transactionId,
        actualPriceFen: verified.actualPriceFen,
        payerOpenid: openid,
        paidAt: verified.paidTimeSeconds ? new Date(verified.paidTimeSeconds * 1_000) : currentTime,
      });
      if (outcome.duplicate) {
        counter.duplicate += 1;
        return;
      }
      counter.granted += 1;
      // 走到这里说明发货推送确实丢过一次：这是回调链路的配置问题，必须留下可追踪的痕迹
      console.warn(JSON.stringify({
        event: "virtual_payment_delivery_recovered",
        orderId: candidate.id,
        transactionId: verified.transactionId,
      }));
    } catch (error: unknown) {
      counter.unresolved += 1;
      counter.attention.push(candidate.id);
      console.error(JSON.stringify({
        event: "virtual_payment_reconcile_alert",
        reason: "query_or_grant_failed",
        orderId: candidate.id,
        code: error instanceof AppError ? error.code : null,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /**
   * 关掉一笔确认未支付且早已超时的 pending 订单。
   *
   * 更新带 `status = 'pending'` 条件：轮询与发货推送可能在并发处置同一笔订单，
   * 无条件 UPDATE 会把刚刚置为 paid 的单又改回 closed —— 权益发了、订单却关了，
   * 后续退款扣回也会因为「订单不是 paid」而失效。
   *
   * @returns 是否真的关掉了；false 表示这一轮它已被别处改状态，交由下一轮/人工处理
   */
  private async closeStaleOrder(
    orderId: string,
    ageMs: number,
    currentTime: Date,
    counter: ReconcileCounter,
  ): Promise<void> {
    try {
      const result = await this.pool.query(
        `UPDATE pindou_orders
            SET status = 'closed', updated_at = $2
          WHERE id = $1 AND status = 'pending'`,
        [orderId, currentTime],
      );
      if (!result.rowCount) {
        counter.unresolved += 1;
        counter.attention.push(orderId);
        console.error(JSON.stringify({
          event: "virtual_payment_reconcile_alert",
          reason: "close_conflict",
          orderId,
          ageMs,
        }));
        return;
      }
      counter.closed += 1;
      console.warn(JSON.stringify({
        event: "virtual_payment_order_closed",
        orderId,
        ageMs,
      }));
    } catch (error: unknown) {
      counter.unresolved += 1;
      counter.attention.push(orderId);
      console.error(JSON.stringify({
        event: "virtual_payment_reconcile_alert",
        reason: "close_failed",
        orderId,
        ageMs,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /**
   * 处理退款推送：置订单为 refunded，并扣回**尚未消耗**的购买额度。
   *
   * 三道闸，任一不满足都不动额度：
   * ① 退款本身必须成功（retCode=0）—— 退款失败还扣额度，等于用户既没拿回钱也没了商品；
   * ② 订单必须存在且属于推送里的付款人；
   * ③ 订单必须处于 paid —— 未发货的订单本来就没东西可扣。
   *
   * 扣回量取 `min(当前剩余购买额度, 本单发放额度)` 而不是整笔发放量：
   * 已消耗的部分收不回来，硬扣会把 purchased 打成负数，而额度读取把负数钳成 0，
   * 表面看余额归零没问题，用户下次再买时新额度会被这个负余额悄悄吃掉
   * （买 30 用 10 退 30 → 余额 -10；再买 30 只到手 20）。
   */
  public async handleRefund(input: RefundNotification): Promise<RefundOutcome> {
    if (input.retCode !== null && input.retCode !== 0) {
      console.warn(JSON.stringify({
        event: "virtual_payment_refund_rejected",
        reason: "refund_failed",
        retCode: input.retCode,
        retMsg: input.retMsg,
      }));
      return { applied: false, clawedBack: 0 };
    }

    const orderId = (input.mchOrderId ?? input.attach ?? "").trim();
    if (!orderId) {
      // 最糟的一种：钱已经退出去了，而我们连扣谁的都不知道，必须留痕让人介入
      console.error(JSON.stringify({
        event: "virtual_payment_refund_alert",
        reason: "order_unlocatable",
        mchOrderId: input.mchOrderId,
        attach: input.attach,
        wxRefundId: input.wxRefundId,
      }));
      return { applied: false, clawedBack: 0 };
    }

    const currentTime = this.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const orderResult = await client.query<OrderRow>(
        `SELECT orders.id, orders.user_id, orders.package_label_snapshot,
                orders.quota_amount_snapshot, orders.quota_kind_snapshot,
                orders.status, orders.paid_at, users.openid_ciphertext
           FROM pindou_orders orders
           JOIN pindou_users users ON users.id = orders.user_id
          WHERE orders.id = $1
          LIMIT 1
          FOR UPDATE OF orders`,
        [orderId],
      );
      const order = orderResult.rows[0];
      if (!order) {
        await client.query("ROLLBACK");
        console.error(JSON.stringify({
          event: "virtual_payment_refund_alert",
          reason: "order_not_found",
          orderId,
        }));
        return { applied: false, clawedBack: 0 };
      }
      const payerOpenid = decryptOpenidOrEmpty(order.openid_ciphertext, this.openidEncryptionSecret);
      if (payerOpenid && input.openId && payerOpenid !== input.openId) {
        await client.query("ROLLBACK");
        console.error(JSON.stringify({
          event: "virtual_payment_refund_alert",
          reason: "payer_mismatch",
          orderId,
        }));
        return { applied: false, clawedBack: 0 };
      }
      if (order.status === "refunded") {
        await client.query("COMMIT");
        return { applied: false, clawedBack: 0 };
      }
      if (order.status !== "paid") {
        await client.query("ROLLBACK");
        console.warn(JSON.stringify({
          event: "virtual_payment_refund_rejected",
          reason: "order_not_paid",
          orderId,
          status: order.status,
        }));
        return { applied: false, clawedBack: 0 };
      }
      if (order.quota_kind_snapshot !== "ai_generation" || order.quota_amount_snapshot <= 0) {
        await client.query("ROLLBACK");
        console.error(JSON.stringify({
          event: "virtual_payment_refund_alert",
          reason: "order_snapshot_invalid",
          orderId,
        }));
        return { applied: false, clawedBack: 0 };
      }

      await lockQuotaUser(client, order.user_id);
      const quota = await readQuota(client, order.user_id, "ai_generation", shanghaiDate(currentTime));
      const clawBack = Math.max(0, Math.min(quota.purchased, order.quota_amount_snapshot));

      await client.query(
        `UPDATE pindou_orders
            SET status = 'refunded', updated_at = $2
          WHERE id = $1 AND status = 'paid'`,
        [order.id, currentTime],
      );
      if (clawBack > 0) {
        await client.query(
          `INSERT INTO pindou_quota_transactions (
             id, user_id, quota_kind, type, amount, source, bucket, quota_date, order_id,
             download_record_id, idempotency_key, note, created_at
           ) VALUES ($1, $2, $3, 'refund', $4, 'payment', 'purchased', NULL,
                     $5, NULL, $6, $7, $8)
           ON CONFLICT DO NOTHING`,
          [
            createEntityId("qt"),
            order.user_id,
            order.quota_kind_snapshot,
            -clawBack,
            order.id,
            `refund:${order.id}`,
            `退款扣回：${order.package_label_snapshot}`.slice(0, 255),
            currentTime,
          ],
        );
      }
      await client.query("COMMIT");
      console.warn(JSON.stringify({
        event: "virtual_payment_refund_applied",
        orderId: order.id,
        grantedAmount: order.quota_amount_snapshot,
        clawedBack: clawBack,
        // 已消耗的部分是本单的真实成本，记下来便于核算退款损失
        consumed: order.quota_amount_snapshot - clawBack,
        refundFeeFen: input.refundFeeFen,
      }));
      return { applied: true, clawedBack: clawBack };
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 应答 iOS 退款问询：如实告诉 Apple 这笔虚拟商品发没发、还剩多少。
   *
   * 判定**以我方订单记录为准**，不采信推送里的 provide_status —— 那是平台侧状态，
   * 而且问询推送同样没有签名。答错只影响 Apple 的判断，不涉及放款，但答得越实越有利。
   *
   * 3 秒的应答窗口意味着这里只能做索引查询，不能有复杂计算或远程调用。
   */
  public async answerIosRefundQuery(input: IosRefundQueryNotification): Promise<IosRefundQueryAnswer> {
    const orderId = (input.payOrderId ?? "").trim();
    if (!orderId) {
      return {
        resultCode: 0,
        resultInfo: "无法定位订单，不主张拒绝退款",
        evidence: `问询未携带支付订单号（票据号 ${input.channelBill ?? "未知"}），无法确认发货情况`,
      };
    }
    const result = await this.pool.query<OrderRow>(
      `SELECT id, user_id, quota_amount_snapshot, quota_kind_snapshot, status, paid_at
         FROM pindou_orders
        WHERE id = $1
        LIMIT 1`,
      [orderId],
    );
    const order = result.rows[0];
    if (!order) {
      return {
        resultCode: 0,
        resultInfo: "未查询到对应订单，不主张拒绝退款",
        evidence: `订单 ${orderId} 不存在`,
      };
    }
    if (order.status !== "paid") {
      return {
        resultCode: 0,
        resultInfo: "订单尚未完成发货，同意退款",
        evidence: `订单 ${orderId} 状态为 ${order.status}，虚拟商品尚未交付`,
      };
    }

    const evidence = await this.describeDeliveredOrder(order);
    return {
      resultCode: 1,
      resultInfo: "虚拟商品已交付，建议拒绝退款",
      evidence,
    };
  }

  /**
   * 生成 iOS 退款问询的举证文案：已发多少、还剩多少。
   *
   * 读额度失败不能拖累应答 —— 那会让我们错过 3 秒窗口。
   * 少了「剩余」这一句，举证仍然成立（已交付是事实），只是说服力弱一点。
   */
  private async describeDeliveredOrder(order: OrderRow): Promise<string> {
    const paidAt = order.paid_at ? String(order.paid_at) : "未知时间";
    const base = `订单 ${order.id} 已于 ${paidAt} 发放 AI 生成次数 ${order.quota_amount_snapshot} 次，属已交付的虚拟商品`;
    try {
      const quota = await readQuota(
        this.pool,
        order.user_id,
        "ai_generation",
        shanghaiDate(this.now()),
      );
      return `${base}；该用户当前购买额度剩余 ${quota.purchased} 次`;
    } catch {
      return base;
    }
  }

  /**
   * 处理虚拟支付发货推送：先验真 → 再置为 paid → 写入购买额度流水。
   *
   * **为什么不能直接信推送**：虚拟支付的发货推送是明文 XML/JSON，
   * 既没有 RSA 验签也没有序列号比对，任何人构造一次 HTTP 请求就能伪造「某某已付款」。
   * 因此这里在发货前强制调 query_order 反向确认 —— 那是服务端用 AppKey 签名、
   * 双向认证的权威结果。宁可少发货（用户找客服能补），也绝不凭推送白送额度。
   *
   * @returns duplicate=true 表示该订单早已到账，不做二次发放
   */
  public async handleDelivery(input: DeliveryNotification): Promise<{ readonly duplicate: boolean }> {
    const openid = input.openId.trim();
    const orderId = input.outTradeNo.trim();
    if (!openid || !orderId) {
      throw new AppError(400, "VIRTUAL_PAYMENT_DELIVERY_INVALID", "发货推送缺少 openid 或订单号");
    }

    const verified = await this.virtualPay.queryOrder({ openid, orderId });
    if (!verified.paid) {
      /**
       * 查单未确认支付成功。
       *
       * 注意这里**刻意返回 duplicate=true 而非抛错**：支付回调失败时微信会重试最多 15 次，
       * 若抛错，一次正常的「用户尚未付款/延迟可见」会被放大成 15 次告警噪音。
       * 返回成功让平台停止重试，真正的漏发货由兜底定时任务扫描补发。
       */
      console.warn(JSON.stringify({
        event: "virtual_payment_delivery_unverified",
        orderId,
        mchOrderNo: input.mchOrderNo,
      }));
      return { duplicate: true };
    }

    const paidAt = verified.paidTimeSeconds
      ? new Date(verified.paidTimeSeconds * 1_000)
      : this.now();
    return this.confirmAndGrant(orderId, {
      mchOrderNo: verified.mchOrderNo,
      transactionId: verified.transactionId,
      actualPriceFen: verified.actualPriceFen,
      payerOpenid: openid,
      paidAt,
    });
  }

  /**
   * 置订单为 paid 并写入一次性购买额度流水。
   *
   * 幂等三重保障：① SELECT FOR UPDATE 行锁串行化并发回调；② UPDATE 带 status='pending' 条件；
   * ③ 额度流水唯一索引 + ON CONFLICT DO NOTHING。任一层漏判都不会重复发放。
   */
  private async confirmAndGrant(
    orderId: string,
    payment: {
      readonly mchOrderNo: string | null;
      readonly transactionId: string | null;
      readonly actualPriceFen: number | null;
      readonly payerOpenid: string;
      readonly paidAt: Date;
    },
  ): Promise<{ readonly duplicate: boolean }> {
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
        [orderId],
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
      if (payerOpenid !== payment.payerOpenid) {
        throw new AppError(400, "PAYMENT_PAYER_MISMATCH", "支付付款人与订单归属不一致");
      }
      // 实付金额已知时必须与订单快照一致，防止改价/越权下单
      if (payment.actualPriceFen !== null && payment.actualPriceFen !== order.price_fen) {
        throw new AppError(400, "PAYMENT_ORDER_MISMATCH", "支付金额与订单不符");
      }

      if (order.status === "paid") {
        if (payment.transactionId && order.wx_transaction_id !== payment.transactionId) {
          throw new AppError(409, "PAYMENT_TRANSACTION_MISMATCH", "订单已绑定另一支付交易号");
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
        console.log(JSON.stringify({
          event: "payment_delivery_duplicate",
          orderId: order.id,
          source: payment.mchOrderNo ? "virtual" : "legacy",
        }));
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

      const paidAt = payment.paidAt;
      await client.query(
        `UPDATE pindou_orders
            SET status = 'paid', wx_transaction_id = $2, paid_at = $3, updated_at = $3
          WHERE id = $1 AND status = 'pending'`,
        [order.id, payment.transactionId, paidAt],
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
        event: "payment_granted",
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

  /**
   * 旧通道（商户号 + APIv3）支付回调，**仅用于收尾存量订单**。
   *
   * 保留原因：切换瞬间可能存在「已用旧通道付款、回调尚未送达」的在途订单，
   * 贸然删除这部分代码会让这些用户「钱扣了、次数没到账」且无法自动恢复。
   * 待确认无存量 pending 订单后（距今最后一笔旧订单超过支付有效期），
   * 可连同 wechat-pay-client、/api/payments/notify 路由与 WECHAT_PAY_* 配置一并下线。
   */
  public async handleNotification(input: PaymentNotificationInput): Promise<{ readonly duplicate: boolean }> {
    const notification = this.legacyPay.verifyNotification(input);
    if (notification.eventType !== "TRANSACTION.SUCCESS" || notification.tradeState !== "SUCCESS") {
      throw new AppError(400, "PAYMENT_STATE_INVALID", "微信支付状态不是成功");
    }
    if (notification.currency !== "CNY") {
      throw new AppError(400, "PAYMENT_ORDER_MISMATCH", "支付币种与订单不符");
    }
    /**
     * 商户号/appId/订单号/付款人四项一致性已在底层 verifyNotification（平台证书验签）与
     * confirmAndGrant（按订单号回查 + 付款人比对）中覆盖，这里只补切面缺失的金额校验。
     */
    return this.confirmAndGrant(notification.orderId, {
      mchOrderNo: null,
      transactionId: notification.transactionId,
      actualPriceFen: notification.amountFen,
      payerOpenid: notification.payerOpenid,
      paidAt: notification.paidAt ?? this.now(),
    });
  }
}
