import type { Pool } from "pg";
import { AppError } from "../../shared/app-error";
import { decryptOpenid } from "../../shared/identity";
import type { PendingOrderReconcileOptions, PendingOrderReconcileSummary } from "./payment-service-contracts";
import {
  decryptOpenidOrEmpty,
  emptyReconcileCounter,
  freezeReconcileCounter,
  orderCreatedAtMs,
  queriedPaymentState,
  type ReconcileCandidateRow,
  type ReconcileCounter,
} from "./payment-service-model";
import type { WeChatPaymentGateway } from "./wechat-pay-client";
import type { VirtualPayGateway } from "./virtual-pay-client";
import { PaymentSettlementService } from "./payment-settlement";

const RECONCILE_ATTENTION_LOG_LIMIT = 20;

export class PaymentReconciliationService extends PaymentSettlementService {
  public constructor(
    pool: Pool,
    virtualPay: VirtualPayGateway,
    legacyPay: WeChatPaymentGateway,
    openidEncryptionSecret: string,
    now: () => Date,
    protected readonly reconcileOptions: PendingOrderReconcileOptions,
  ) {
    super(pool, virtualPay, legacyPay, openidEncryptionSecret, now);
  }
  public async reconcilePendingOrders(userId?: string): Promise<PendingOrderReconcileSummary> {
    const counter = emptyReconcileCounter();
    // 网关未配置时压根不存在虚拟支付订单，扫一遍只会空转并打出误导性的日志
    if (!this.virtualPay.configured) return freezeReconcileCounter(counter);

    const currentTime = this.now();
    const expiredClosed = await this.pool.query(
      `UPDATE pindou_orders orders
          SET status = 'closed', closed_at = $1, updated_at = $1
        WHERE orders.status = 'pending' AND orders.expires_at <= $1
          AND ($2::varchar IS NULL OR orders.user_id = $2)
          AND EXISTS (SELECT 1 FROM pindou_payment_attempts attempts WHERE attempts.order_id = orders.id)
          AND NOT EXISTS (SELECT 1 FROM pindou_payment_attempts attempts
                           WHERE attempts.order_id = orders.id AND attempts.status <> 'CLOSED')`,
      [currentTime, userId ?? null],
    );
    counter.closed += expiredClosed.rowCount ?? 0;
    const result = await this.pool.query<ReconcileCandidateRow>(
      `SELECT orders.id, attempts.id AS attempt_id, orders.created_at, orders.expires_at,
              users.openid_ciphertext, attempts.out_trade_no
         FROM pindou_orders orders
         JOIN pindou_users users ON users.id = orders.user_id
         JOIN pindou_payment_attempts attempts ON attempts.order_id = orders.id
        WHERE orders.status = 'pending'
          AND ($4::varchar IS NULL OR orders.user_id = $4)
          AND attempts.status IN ('ISSUED', 'UNKNOWN')
          AND ((attempts.status = 'ISSUED' AND orders.expires_at <= $1) OR
               (attempts.status = 'UNKNOWN' AND
                (attempts.last_query_at IS NULL OR attempts.last_query_at <= $2)))
        ORDER BY COALESCE(attempts.last_query_at, attempts.created_at) ASC
        LIMIT $3`,
      [currentTime, new Date(currentTime.getTime() - this.reconcileOptions.graceMs), this.reconcileOptions.batchSize, userId ?? null],
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
      // 查单必须带上本次支付尝试的商户单号：订单号在微信侧根本不存在
      const verified = await this.virtualPay.queryOrder({ openid, outTradeNo: candidate.out_trade_no });
      const state = queriedPaymentState(verified);
      const ageMs = currentTime.getTime() - orderCreatedAtMs(candidate.created_at);
      if (state === "CLOSED") {
        await this.updateAttemptQuery(candidate.attempt_id, "CLOSED", null);
        if (await this.closeOrderIfAttemptsClosed(candidate.id, currentTime)) counter.closed += 1;
        else counter.unpaid += 1;
        return;
      }
      if (state === "UNPAID" && currentTime.getTime() < orderCreatedAtMs(candidate.expires_at)) {
        await this.updateAttemptQuery(candidate.attempt_id, "ISSUED", null);
        counter.unpaid += 1;
        return;
      }
      if (state === "UNPAID") {
        await this.updateAttemptQuery(candidate.attempt_id, "CLOSED", "expired_unpaid");
        if (await this.closeOrderIfAttemptsClosed(candidate.id, currentTime)) {
          counter.closed += 1;
          console.warn(JSON.stringify({ event: "virtual_payment_order_closed", orderId: candidate.id }));
        } else {
          counter.unpaid += 1;
        }
        return;
      }
      if (state === "REFUNDED") {
        await this.handleRefund({
          openId: openid,
          mchOrderId: candidate.out_trade_no,
          attach: candidate.id,
          wxRefundId: null,
          refundFeeFen: verified.actualPriceFen,
          retCode: 0,
          retMsg: null,
          refundSuccTimestamp: null,
        });
        return;
      }
      if (state !== "PAID") {
        const reason = "provider_status_unknown";
        await this.updateAttemptQuery(candidate.attempt_id, "UNKNOWN", reason);
        counter.unresolved += 1;
        counter.attention.push(candidate.id);
        if (ageMs >= this.reconcileOptions.staleAfterMs) counter.stalled += 1;
        console.error(JSON.stringify({ event: "virtual_payment_reconcile_alert", reason, orderId: candidate.id, attemptId: candidate.attempt_id, ageMs }));
        return;
      }
      const outcome = await this.confirmAndGrant(candidate.id, {
        attemptId: candidate.attempt_id,
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
      await this.updateAttemptQuery(candidate.attempt_id, "UNKNOWN", error instanceof Error ? error.message : String(error));
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

}
