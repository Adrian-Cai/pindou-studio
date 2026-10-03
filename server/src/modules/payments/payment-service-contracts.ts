/**
 * 支付模块的公共输入、输出与服务接口。
 * 调用方：支付实现、订单模型、结算/补单服务与 HTTP 路由。
 * 这里只声明契约，不放数据库行模型或支付处理逻辑。
 */
import type { PaymentNotificationInput, PaymentParameters } from "./wechat-pay-client";
import type {
  DeliveryNotification,
  IosRefundQueryAnswer,
  IosRefundQueryNotification,
  RefundNotification,
  VirtualPaymentPayload,
} from "./virtual-pay-client";

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
 * virtual 里的 signData 使用该订单唯一的支付尝试号；微信确认未支付时沿用原号，
 * 尝试已关闭后必须新建订单，不能在原订单下创建第二个尝试。
 */
export interface CreatePaymentResponse {
  readonly orderId: string;
  readonly virtual: VirtualPaymentPayload | null;
  /** 旧通道遗留字段：始终为 null，待旧回调链路下线后移除。 */
  readonly payment: PaymentParameters | null;
}

/** 订单状态机：pending 可转 paid / failed / closed；经微信确认的迟到支付可将 closed 修正为 paid。 */
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
  /** 支付截止时间；超时后由服务端核实微信状态，确认未支付或已关闭才关闭订单。 */
  readonly expiresAt: string | null;
  readonly paidAt: string | null;
}

export interface OrderListResponse {
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** 当前 pending 订单数，与 createPayment 的 MAX_PENDING_ORDERS 上限同口径。 */
  readonly pendingCount: number;
  /** 服务端当前时间：客户端倒计时用它校准时钟偏差，不能用本机时间直减。 */
  readonly serverTime: string;
  readonly items: readonly OrderItem[];
}

/** 继续支付输入：订单页只持有 orderId，归属校验在服务端完成。 */
export interface ContinuePaymentInput {
  readonly userId: string;
  readonly orderId: string;
}

/** 用户主动取消订单的输入。 */
export interface CancelOrderInput {
  readonly userId: string;
  readonly orderId: string;
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
  /**
   * 继续支付一笔 pending 订单：不创建新订单，经微信查单核实后重发支付参数。
   *
   * 与 createPayment 的区别：入口是订单页上的 orderId（没有幂等键），
   * 归属与状态校验全部在服务端完成；「继续支付」永远指向当前这张 Order。
   */
  continuePayment(input: ContinuePaymentInput): Promise<CreatePaymentResponse>;
  /**
   * 用户主动取消一笔 pending 订单。
   *
   * 取消前必须先查微信真实状态：已支付的要照常发货并告诉用户「已支付」，
   * 查单失败时不能关单（PAYMENT_STATUS_CONFIRMING），只有确认未付/已关才本地关闭。
   */
  cancelOrder(input: CancelOrderInput): Promise<{ readonly status: "closed" }>;
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
