const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const test = require("node:test");
const { loadLocalEnv, readConfig } = require("../dist/config/env.js");
const { createPool } = require("../dist/db/pool.js");
const { AppError } = require("../dist/shared/app-error.js");
const { encryptOpenid } = require("../dist/shared/identity.js");
const { PostgresPaymentService } = require("../dist/modules/payments/payment-service.js");

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";

test("stage 5 real database flow: package snapshot, tamper rejection, verified grant and duplicate callback", { skip: !enabled }, async () => {
  loadLocalEnv();
  const config = readConfig();
  const pool = createPool(config.database);
  const suffix = randomBytes(6).toString("hex");
  const userId = `usr_pay_${suffix}`;
  const enabledPackageId = `ai_generation_30_${suffix}`;
  const disabledPackageId = `hidden_${suffix}`;
  const openid = `openid_${suffix}`;
  const now = new Date("2026-08-31T12:00:00.000Z");
  let createCount = 0;
  let verificationError = null;
  let notification = null;
  const gateway = {
    configured: true,
    appId: "wx-stage5-app",
    merchantId: "stage5-mch",
    async createPayment(input) {
      createCount += 1;
      assert.equal(input.amountFen, 990);
      assert.equal(input.payerOpenid, openid);
      return {
        prepayId: `wx_prepay_${suffix}`,
        payment: this.paymentParameters(`wx_prepay_${suffix}`),
      };
    },
    paymentParameters(prepayId) {
      return { timeStamp: "1788177600", nonceStr: "nonce", package: `prepay_id=${prepayId}`, signType: "RSA", paySign: "test-pay-sign" };
    },
    verifyNotification() {
      if (verificationError) throw verificationError;
      return notification;
    },
  };

  try {
    await pool.query(
      `INSERT INTO pindou_users (
         id, openid_hash, openid_ciphertext, nickname, avatar_url, created_at, updated_at, deleted_at
       ) VALUES ($1, $2, $3, '支付联调用户', NULL, $4, $4, NULL)`,
      [userId, `payment_${suffix}`, encryptOpenid(openid, config.auth.openidHashSecret), now],
    );
    await pool.query(
      `INSERT INTO pindou_packages (
         id, label, quota_amount, quota_kind, membership_type, membership_days,
         price_fen, currency, enabled, sort_order, created_at, updated_at
       ) VALUES
         ($1, 'AI 精致生成 30 次', 30, 'ai_generation', NULL, NULL, 990, 'CNY', TRUE, 1, $3, $3),
         ($2, '隐藏套餐', 99, 'ai_generation', NULL, NULL, 1, 'CNY', FALSE, 0, $3, $3)`,
      [enabledPackageId, disabledPackageId, now],
    );

    const service = new PostgresPaymentService(pool, gateway, config.auth.openidHashSecret, () => now);
    const packages = await service.listPackages();
    assert.ok(packages.items.some((item) => item.id === enabledPackageId));
    assert.ok(packages.items.every((item) => item.id !== disabledPackageId));
    const created = await service.createPayment({
      userId,
      packageId: enabledPackageId,
      idempotencyKey: `stage5-create-${suffix}`,
    });
    const retried = await service.createPayment({
      userId,
      packageId: enabledPackageId,
      idempotencyKey: `stage5-create-${suffix}`,
    });
    assert.equal(retried.orderId, created.orderId);
    assert.equal(createCount, 1);

    const snapshot = await pool.query(
      `SELECT package_label_snapshot, quota_amount_snapshot, quota_kind_snapshot,
              membership_type_snapshot, price_fen, status, wx_prepay_id
         FROM pindou_orders
        WHERE id = $1`,
      [created.orderId],
    );
    assert.deepEqual(snapshot.rows[0], {
      package_label_snapshot: "AI 精致生成 30 次",
      quota_amount_snapshot: 30,
      quota_kind_snapshot: "ai_generation",
      membership_type_snapshot: null,
      price_fen: 990,
      status: "pending",
      wx_prepay_id: `wx_prepay_${suffix}`,
    });

    const validNotification = {
      eventType: "TRANSACTION.SUCCESS",
      merchantId: gateway.merchantId,
      appId: gateway.appId,
      orderId: created.orderId,
      transactionId: `wx_tx_${suffix}`,
      tradeState: "SUCCESS",
      amountFen: 990,
      currency: "CNY",
      payerOpenid: openid,
      paidAt: now,
    };
    notification = { ...validNotification, amountFen: 1 };
    await assert.rejects(
      () => service.handleNotification({ rawBody: "{}", headers: {} }),
      (error) => error.code === "PAYMENT_ORDER_MISMATCH",
    );
    notification = { ...validNotification, eventType: "TRANSACTION.CLOSED", tradeState: "CLOSED" };
    await assert.rejects(
      () => service.handleNotification({ rawBody: "{}", headers: {} }),
      (error) => error.code === "PAYMENT_STATE_INVALID",
    );
    notification = { ...validNotification, orderId: `order_missing_${suffix}` };
    await assert.rejects(
      () => service.handleNotification({ rawBody: "{}", headers: {} }),
      (error) => error.code === "NOT_FOUND",
    );
    verificationError = new AppError(401, "PAYMENT_NOTIFY_SIGNATURE_INVALID", "验签失败");
    await assert.rejects(
      () => service.handleNotification({ rawBody: "{}", headers: {} }),
      (error) => error.code === "PAYMENT_NOTIFY_SIGNATURE_INVALID",
    );

    verificationError = null;
    notification = validNotification;
    assert.deepEqual(await service.handleNotification({ rawBody: "{}", headers: {} }), { duplicate: false });
    assert.deepEqual(await service.handleNotification({ rawBody: "{}", headers: {} }), { duplicate: true });
    const finalState = await pool.query(
      `SELECT orders.status, orders.wx_transaction_id, orders.paid_at,
              COUNT(transactions.id)::int AS grant_count,
              COALESCE(SUM(transactions.amount), 0)::int AS granted_quota
         FROM pindou_orders orders
         LEFT JOIN pindou_quota_transactions transactions
           ON transactions.order_id = orders.id AND transactions.type = 'purchase_grant'
        WHERE orders.id = $1
        GROUP BY orders.id`,
      [created.orderId],
    );
    assert.equal(finalState.rows[0].status, "paid");
    assert.equal(finalState.rows[0].wx_transaction_id, `wx_tx_${suffix}`);
    assert.equal(finalState.rows[0].grant_count, 1);
    assert.equal(finalState.rows[0].granted_quota, 3);
  } finally {
    await pool.query("DELETE FROM pindou_quota_transactions WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM pindou_orders WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM pindou_packages WHERE id = ANY($1::varchar[])", [[enabledPackageId, disabledPackageId]]);
    await pool.query("DELETE FROM pindou_users WHERE id = $1", [userId]);
    await pool.end();
  }
});
