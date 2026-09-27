import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { AppError, notFound } from "../../shared/app-error";
import { createEntityId, decryptOpenid } from "../../shared/identity";
import { rollbackTransaction } from "../../shared/transaction";
import { shanghaiDate } from "../../shared/shanghai-time";
import { lockQuotaUser, readQuota } from "../quota/quota-ledger";
import type { PaymentNotificationInput, WeChatPaymentGateway } from "./wechat-pay-client";
import type {
  DeliveryNotification,
  IosRefundQueryAnswer,
  IosRefundQueryNotification,
  QueriedVirtualOrder,
  RefundNotification,
  VirtualPayGateway,
} from "./virtual-pay-client";
import type { RefundOutcome } from "./payment-service";
import type { OrderRow, PaymentAttemptRow } from "./payment-service-model";
import { decryptOpenidOrEmpty, queriedPaymentState } from "./payment-service-model";

export class PaymentSettlementService {
  protected constructor(
    protected readonly pool: Pool,
    protected readonly virtualPay: VirtualPayGateway,
    protected readonly legacyPay: WeChatPaymentGateway,
    protected readonly openidEncryptionSecret: string,
    protected readonly now: () => Date,
  ) {}
  protected async updateAttemptQuery(
    attemptId: string,
    status: PaymentAttemptRow["status"],
    failureReason: string | null,
  ): Promise<void> {
    const queriedAt = this.now();
    await this.pool.query(
      `UPDATE pindou_payment_attempts
          SET status = $2,
              closed_at = CASE WHEN $2 = 'CLOSED' THEN COALESCE(closed_at, $4) ELSE closed_at END,
              last_query_at = $4, query_count = query_count + 1, failure_reason = $3
        WHERE id = $1`,
      [attemptId, status, failureReason?.slice(0, 255) ?? null, queriedAt],
    );
  }

  protected async closeOrderIfAttemptsClosed(orderId: string, currentTime: Date): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const order = await client.query<{ readonly id: string }>(
        `SELECT id FROM pindou_orders WHERE id = $1 AND status = 'pending' AND expires_at <= $2 FOR UPDATE`,
        [orderId, currentTime],
      );
      if (!order.rows[0]) {
        await client.query("COMMIT");
        return false;
      }
      const active = await client.query<{ readonly total: number }>(
        `SELECT COUNT(*)::int AS total FROM pindou_payment_attempts
          WHERE order_id = $1 AND status <> 'CLOSED'`,
        [orderId],
      );
      if ((active.rows[0]?.total ?? 0) > 0) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `UPDATE pindou_orders SET status = 'closed', closed_at = $2, updated_at = $2
          WHERE id = $1 AND status = 'pending'`,
        [orderId, currentTime],
      );
      await client.query("COMMIT");
      return true;
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 由微信侧的商户单号（outTradeNo）回查我方订单号。
   *
   * 商户单号与订单号**不是同一个值**：微信规定 outTradeNo 只能用一次，一笔订单
   * 被反复拉起支付时每次都会换新号（见 createPayment）。因此发货推送、退款推送、
   * iOS 退款问询带回来的都是商户单号，必须先经这一步才能定位订单。
   *
   * 保留 `OR id = $1` 这一路兜底，是为了**迁移尚未执行时**存量在途订单仍能收尾：
   * 迁移前下发的 signData 用的就是订单号本身，而迁移是人工执行的，
   * 部署顺序上必然存在「代码已上新、列还没加」的窗口。
   *
   * @returns 订单号；null 表示既不是已知商户单号也不是订单号
   */
  protected async resolveOrderId(outTradeNo: string): Promise<string | null> {
    const result = await this.pool.query<{ readonly id: string }>(
      `SELECT order_id AS id
         FROM pindou_payment_attempts
        WHERE out_trade_no = $1
       UNION ALL
       SELECT id
         FROM pindou_orders
        WHERE virtual_out_trade_no = $1 OR id = $1
        LIMIT 1`,
      [outTradeNo],
    );
    return result.rows[0]?.id ?? null;
  }

  protected async beginPaymentEvent(
    eventType: string,
    fingerprintParts: readonly (string | number | null)[],
    outTradeNo: string | null,
  ): Promise<{ readonly id: string; readonly duplicate: boolean; readonly attemptId: string | null; readonly orderId: string | null }> {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([eventType, ...fingerprintParts]), "utf8")
      .digest("hex");
    const attempt = outTradeNo
      ? (await this.pool.query<{ readonly id: string; readonly order_id: string }>(
        `SELECT id, order_id FROM pindou_payment_attempts WHERE out_trade_no = $1 LIMIT 1`,
        [outTradeNo],
      )).rows[0]
      : undefined;
    const inserted = await this.pool.query<{ readonly id: string; readonly order_id: string | null; readonly attempt_id: string | null }>(
      `INSERT INTO pindou_payment_events (
         id, provider, event_type, event_fingerprint, order_id, attempt_id, status, created_at
       ) VALUES ($1, 'wechat_virtual', $2, $3, $4, $5, 'RECEIVED', $6)
       ON CONFLICT (provider, event_fingerprint) DO NOTHING
       RETURNING id, order_id, attempt_id`,
      [createEntityId("pe"), eventType, fingerprint, attempt?.order_id ?? null, attempt?.id ?? null, this.now()],
    );
    if (inserted.rows[0]) return {
      id: inserted.rows[0].id,
      duplicate: false,
      attemptId: attempt?.id ?? null,
      orderId: attempt?.order_id ?? null,
    };
    const existing = await this.pool.query<{ readonly id: string; readonly status: string; readonly attempt_id: string | null; readonly order_id: string | null }>(
      `SELECT id, status, attempt_id, order_id FROM pindou_payment_events
        WHERE provider = 'wechat_virtual' AND event_fingerprint = $1 LIMIT 1`,
      [fingerprint],
    );
    const event = existing.rows[0];
    if (!event) throw new Error("支付事件幂等记录读取失败");
    if (event.status === "PROCESSED") return {
      id: event.id,
      duplicate: true,
      attemptId: event.attempt_id,
      orderId: event.order_id,
    };
    await this.pool.query(
      `UPDATE pindou_payment_events SET status = 'RECEIVED', failure_reason = NULL WHERE id = $1`,
      [event.id],
    );
    return { id: event.id, duplicate: false, attemptId: event.attempt_id, orderId: event.order_id };
  }

  protected async finishPaymentEvent(
    eventId: string,
    status: "PROCESSED" | "QUERY_FAILED" | "DATA_MISMATCH" | "PROCESS_FAILED",
    failureReason: string | null = null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE pindou_payment_events
          SET status = $2, failure_reason = $3, processed_at = $4
        WHERE id = $1`,
      [eventId, status, failureReason?.slice(0, 255) ?? null, this.now()],
    );
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
  public async handleRefund(input: RefundNotification): Promise<RefundOutcome> {
    const identifier = (input.mchOrderId ?? input.attach ?? "").trim();
    const event = await this.beginPaymentEvent("xpay_refund_notify", [
      identifier, input.wxRefundId, input.refundFeeFen, input.retCode, input.refundSuccTimestamp,
    ], input.mchOrderId);
    if (event.duplicate) return { applied: false, clawedBack: 0 };
    if (input.retCode !== null && input.retCode !== 0) {
      await this.finishPaymentEvent(event.id, "PROCESSED", "refund_failed");
      console.warn(JSON.stringify({
        event: "virtual_payment_refund_rejected",
        reason: "refund_failed",
        retCode: input.retCode,
        retMsg: input.retMsg,
      }));
      return { applied: false, clawedBack: 0 };
    }

    if (!identifier) {
      // 最糟的一种：钱已经退出去了，而我们连扣谁的都不知道，必须留痕让人介入
      console.error(JSON.stringify({
        event: "virtual_payment_refund_alert",
        reason: "order_unlocatable",
        mchOrderId: input.mchOrderId,
        attach: input.attach,
        wxRefundId: input.wxRefundId,
      }));
      await this.finishPaymentEvent(event.id, "DATA_MISMATCH", "refund_order_unlocatable");
      return { applied: false, clawedBack: 0 };
    }

    // 推送里的商户单号不是订单号，先回查定位
    const orderId = await this.resolveOrderId(identifier);
    if (!orderId) {
      console.error(JSON.stringify({
        event: "virtual_payment_refund_alert",
        reason: "order_not_found",
        mchOrderId: input.mchOrderId,
        attach: input.attach,
        wxRefundId: input.wxRefundId,
      }));
      await this.finishPaymentEvent(event.id, "DATA_MISMATCH", "refund_order_not_found");
      return { applied: false, clawedBack: 0 };
    }

    const attemptResult = await this.pool.query<PaymentAttemptRow>(
      `SELECT attempts.id, attempts.order_id, attempts.user_id, attempts.out_trade_no,
              attempts.status, attempts.wechat_transaction_id, attempts.amount_fen,
              attempts.created_at, attempts.paid_at, attempts.closed_at, orders.status AS order_status
         FROM pindou_payment_attempts attempts
         JOIN pindou_orders orders ON orders.id = attempts.order_id
        WHERE attempts.out_trade_no = $1 OR (attempts.order_id = $2 AND attempts.status = 'SUCCEEDED')
        ORDER BY CASE WHEN attempts.out_trade_no = $1 THEN 0 ELSE 1 END, attempts.created_at DESC
        LIMIT 1`,
      [identifier, input.attach],
    );
    const attempt = attemptResult.rows[0];
    if (!attempt) {
      await this.finishPaymentEvent(event.id, "DATA_MISMATCH", "refund_attempt_not_found");
      return { applied: false, clawedBack: 0 };
    }
    await this.pool.query(
      `UPDATE pindou_payment_events SET order_id = $2, attempt_id = $3 WHERE id = $1`,
      [event.id, orderId, attempt.id],
    );
    let verified: QueriedVirtualOrder;
    try {
      verified = await this.virtualPay.queryOrder({ openid: input.openId, outTradeNo: attempt.out_trade_no });
    } catch (error: unknown) {
      await this.finishPaymentEvent(event.id, "QUERY_FAILED", "wechat_refund_fact_query_failed");
      await this.updateAttemptQuery(attempt.id, "UNKNOWN", error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (queriedPaymentState(verified) !== "REFUNDED"
      || (verified.transactionId && attempt.wechat_transaction_id && verified.transactionId !== attempt.wechat_transaction_id)
      || (verified.actualPriceFen !== null && verified.actualPriceFen !== attempt.amount_fen)
      || (input.refundFeeFen !== null && input.refundFeeFen !== attempt.amount_fen)) {
      await this.finishPaymentEvent(event.id, "DATA_MISMATCH", "wechat_refund_fact_mismatch");
      console.error(JSON.stringify({ event: "virtual_payment_refund_alert", reason: "wechat_fact_mismatch", orderId, attemptId: attempt.id }));
      return { applied: false, clawedBack: 0 };
    }
    try {
      if (attempt.order_status === "pending") {
        await this.confirmAndGrant(orderId, {
          attemptId: attempt.id,
          mchOrderNo: verified.mchOrderNo,
          transactionId: verified.transactionId,
          actualPriceFen: verified.actualPriceFen,
          payerOpenid: input.openId,
          paidAt: verified.paidTimeSeconds ? new Date(verified.paidTimeSeconds * 1_000) : this.now(),
        });
      } else if (attempt.order_status !== "paid") {
        await this.finishPaymentEvent(event.id, "DATA_MISMATCH", "refund_order_not_paid");
        return { applied: false, clawedBack: 0 };
      }
    } catch (error: unknown) {
      await this.finishPaymentEvent(event.id, "PROCESS_FAILED", error instanceof AppError ? error.code : "refund_payment_confirmation_failed");
      throw error;
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
        await this.finishPaymentEvent(event.id, "DATA_MISMATCH", "refund_order_not_found");
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
        await this.finishPaymentEvent(event.id, "DATA_MISMATCH", "refund_payer_mismatch");
        return { applied: false, clawedBack: 0 };
      }
      if (order.status === "refunded") {
        await client.query("COMMIT");
        await this.finishPaymentEvent(event.id, "PROCESSED");
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
        await this.finishPaymentEvent(event.id, "DATA_MISMATCH", "refund_order_not_paid");
        return { applied: false, clawedBack: 0 };
      }
      if (order.quota_kind_snapshot !== "ai_generation" || order.quota_amount_snapshot <= 0) {
        await client.query("ROLLBACK");
        console.error(JSON.stringify({
          event: "virtual_payment_refund_alert",
          reason: "order_snapshot_invalid",
          orderId,
        }));
        await this.finishPaymentEvent(event.id, "DATA_MISMATCH", "refund_order_snapshot_invalid");
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
      await client.query(
        `UPDATE pindou_payment_attempts SET status = 'SUCCEEDED', last_query_at = $2,
                query_count = query_count + 1, failure_reason = NULL WHERE id = $1`,
        [attempt.id, currentTime],
      );
      await this.finishPaymentEvent(event.id, "PROCESSED");
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
      await this.finishPaymentEvent(event.id, "PROCESS_FAILED", error instanceof AppError ? error.code : "refund_processing_failed");
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
    // 问询带来的可能是商户单号也可能是订单号（渠道不统一），两种都要能命中
    const result = await this.pool.query<OrderRow>(
      `SELECT id, user_id, quota_amount_snapshot, quota_kind_snapshot, status, paid_at
         FROM pindou_orders
        WHERE virtual_out_trade_no = $1 OR id = $1
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
    const outTradeNo = input.outTradeNo.trim();
    if (!openid || !outTradeNo) {
      throw new AppError(400, "VIRTUAL_PAYMENT_DELIVERY_INVALID", "发货推送缺少 openid 或订单号");
    }
    const event = await this.beginPaymentEvent("xpay_goods_deliver_notify", [
      outTradeNo, input.transactionId, input.paidTimeSeconds, input.actualPriceFen,
    ], outTradeNo);
    if (event.duplicate) return { duplicate: true };
    const orderId = event.orderId ?? await this.resolveOrderId(outTradeNo);
    if (!orderId) {
      await this.finishPaymentEvent(event.id, "DATA_MISMATCH", "payment_attempt_not_found");
      throw notFound("支付订单不存在");
    }

    let verified: QueriedVirtualOrder;
    try {
      verified = await this.virtualPay.queryOrder({ openid, outTradeNo });
    } catch (error: unknown) {
      if (event.attemptId) {
        await this.updateAttemptQuery(event.attemptId, "UNKNOWN", error instanceof Error ? error.message : String(error));
      }
      await this.finishPaymentEvent(event.id, "QUERY_FAILED", "wechat_order_query_failed");
      throw error;
    }
    const state = queriedPaymentState(verified);
    if (state !== "PAID") {
      if (event.attemptId) {
        await this.updateAttemptQuery(
          event.attemptId,
          state === "CLOSED" ? "CLOSED" : state === "UNKNOWN" || state === "REFUNDED" ? "UNKNOWN" : "ISSUED",
          state === "UNKNOWN" ? "unrecognized_provider_status" : null,
        );
      }
      if (state === "CLOSED") await this.closeOrderIfAttemptsClosed(orderId, this.now());
      await this.finishPaymentEvent(event.id, state === "UNKNOWN" ? "QUERY_FAILED" : "PROCESSED", state === "UNKNOWN" ? "unrecognized_provider_status" : null);
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
    try {
      const outcome = await this.confirmAndGrant(orderId, {
        attemptId: event.attemptId ?? undefined,
        mchOrderNo: verified.mchOrderNo,
        transactionId: verified.transactionId,
        actualPriceFen: verified.actualPriceFen,
        payerOpenid: openid,
        paidAt,
      });
      await this.finishPaymentEvent(event.id, "PROCESSED");
      return outcome;
    } catch (error: unknown) {
      const mismatch = error instanceof AppError && [
        "PAYMENT_PAYER_MISMATCH", "PAYMENT_ORDER_MISMATCH", "PAYMENT_TRANSACTION_MISMATCH",
      ].includes(error.code);
      await this.finishPaymentEvent(event.id, mismatch ? "DATA_MISMATCH" : "PROCESS_FAILED", error instanceof AppError ? error.code : "payment_confirmation_failed");
      throw error;
    }
  }

  /**
   * 置订单为 paid 并写入一次性购买额度流水。
   *
   * 幂等三重保障：① SELECT FOR UPDATE 行锁串行化并发回调；② UPDATE 带 status='pending' 条件；
   * ③ 额度流水唯一索引 + ON CONFLICT DO NOTHING。任一层漏判都不会重复发放。
   */
  protected async confirmAndGrant(
    orderId: string,
    payment: {
      readonly attemptId?: string | undefined;
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
      if (payment.attemptId) {
        const attemptResult = await client.query<PaymentAttemptRow>(
          `SELECT id, order_id, user_id, out_trade_no, status, wechat_transaction_id,
                  amount_fen, created_at, paid_at, closed_at
             FROM pindou_payment_attempts
            WHERE id = $1 AND order_id = $2
            LIMIT 1 FOR UPDATE`,
          [payment.attemptId, order.id],
        );
        const attempt = attemptResult.rows[0];
        if (!attempt || attempt.user_id !== order.user_id || attempt.amount_fen !== order.price_fen) {
          throw new AppError(400, "PAYMENT_ORDER_MISMATCH", "支付尝试与订单快照不符");
        }
        if (payment.transactionId && attempt.wechat_transaction_id && attempt.wechat_transaction_id !== payment.transactionId) {
          throw new AppError(409, "PAYMENT_TRANSACTION_MISMATCH", "支付尝试已绑定另一交易号");
        }
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
        if (payment.attemptId) {
          await client.query(
            `UPDATE pindou_payment_attempts
                SET status = 'SUCCEEDED', wechat_transaction_id = COALESCE(wechat_transaction_id, $2),
                    paid_at = COALESCE(paid_at, $3), last_query_at = $3,
                    query_count = query_count + 1, failure_reason = NULL
              WHERE id = $1`,
            [payment.attemptId, payment.transactionId, payment.paidAt],
          );
        }
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
      if (payment.attemptId) {
        await client.query(
          `UPDATE pindou_payment_attempts
              SET status = 'SUCCEEDED', wechat_transaction_id = $2, paid_at = $3,
                  last_query_at = $3, query_count = query_count + 1, failure_reason = NULL
            WHERE id = $1`,
          [payment.attemptId, payment.transactionId, paidAt],
        );
      }
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
