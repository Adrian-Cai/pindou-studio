const assert = require("node:assert/strict");
const test = require("node:test");
const { encryptOpenid } = require("../dist/shared/identity.js");
const { AppError } = require("../dist/shared/app-error.js");
const { PostgresPaymentService } = require("../dist/modules/payments/payment-service.js");

const NOW = new Date("2026-08-31T12:00:00.000Z");
const SECRET = "test_openid_hash_secret_32_characters_long";
const OPENID = "payer-openid-private";

function clientPool(handler) {
  const calls = [];
  let connectCount = 0;
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      return handler(sql, parameters, calls);
    },
    release() {},
  };
  return {
    calls,
    get connectCount() { return connectCount; },
    pool: {
      async connect() { connectCount += 1; return client; },
      async query(sql, parameters = []) {
        calls.push({ sql, parameters });
        return handler(sql, parameters, calls);
      },
    },
  };
}

function paymentParameters() {
  return {
    timeStamp: "1788177600",
    nonceStr: "safe-client-nonce",
    package: "prepay_id=wx_prepay_test",
    signType: "RSA",
    paySign: "safe-client-pay-signature",
  };
}

function packageRow(overrides = {}) {
  return {
    id: "ai_generation_30",
    label: "AI 精致生成 30 次",
    quota_amount: 30,
    quota_kind: "ai_generation",
    membership_type: null,
    membership_days: null,
    price_fen: 990,
    currency: "CNY",
    enabled: true,
    ...overrides,
  };
}

function fakeGateway(overrides = {}) {
  return {
    configured: true,
    appId: "wx-app",
    merchantId: "mch-123",
    async createPayment() {
      return { prepayId: "wx_prepay_test", payment: paymentParameters() };
    },
    paymentParameters,
    verifyNotification() {
      return {
        eventType: "TRANSACTION.SUCCESS",
        merchantId: "mch-123",
        appId: "wx-app",
        orderId: "order_test",
        transactionId: "wx_transaction_1",
        tradeState: "SUCCESS",
        amountFen: 990,
        currency: "CNY",
        payerOpenid: OPENID,
        paidAt: NOW,
      };
    },
    ...overrides,
  };
}

test("packages returns only the enabled rows selected by the server query", async () => {
  const { pool, calls } = clientPool(() => ({ rows: [packageRow()] }));
  const service = new PostgresPaymentService(pool, fakeGateway(), SECRET, () => NOW);
  assert.deepEqual(await service.listPackages(), {
    items: [{
      id: "ai_generation_30",
      label: "AI 精致生成 30 次",
      quotaAmount: 30,
      quotaKind: "ai_generation",
      membershipType: null,
      priceFen: 990,
      currency: "CNY",
      enabled: true,
    }],
  });
  assert.match(calls[0].sql, /WHERE enabled = TRUE/);
  assert.match(calls[0].sql, /ORDER BY sort_order, id/);
});

test("packages fail closed when a database row still carries membership fields", async () => {
  const { pool } = clientPool(() => ({ rows: [packageRow({ membership_type: "monthly" })] }));
  const service = new PostgresPaymentService(pool, fakeGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.listPackages(),
    /数据库套餐不符合支付业务约束/,
  );
});

test("payment creation snapshots server package values and never accepts a client amount", async () => {
  let gatewayInput;
  let orderInsert;
  const encryptedOpenid = encryptOpenid(OPENID, SECRET);
  const gateway = fakeGateway({
    async createPayment(input) {
      gatewayInput = input;
      return { prepayId: "wx_prepay_test", payment: paymentParameters() };
    },
  });
  const { pool } = clientPool((sql, parameters) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM pindou_orders") && !sql.includes("JOIN pindou_users")) return { rows: [] };
    if (sql.includes("FROM pindou_packages")) return { rows: [packageRow()] };
    if (sql.includes("FROM pindou_users")) return { rows: [{ openid_ciphertext: encryptedOpenid }] };
    if (sql.includes("INSERT INTO pindou_orders")) { orderInsert = parameters; return { rows: [] }; }
    if (sql.includes("UPDATE pindou_orders") && sql.includes("wx_prepay_id")) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const service = new PostgresPaymentService(pool, gateway, SECRET, () => NOW);
  const result = await service.createPayment({
    userId: "usr_a",
    packageId: "ai_generation_30",
    idempotencyKey: "create-starter-1",
  });

  assert.match(result.orderId, /^order_[a-f0-9]{26}$/);
  assert.deepEqual(gatewayInput, {
    orderId: result.orderId,
    description: "小露拼豆-AI 精致生成 30 次",
    amountFen: 990,
    currency: "CNY",
    payerOpenid: OPENID,
  });
  assert.equal(orderInsert[3], "AI 精致生成 30 次");
  assert.equal(orderInsert[4], 30);
  assert.equal(orderInsert[5], "ai_generation");
  assert.equal(orderInsert[7], 990);
});

test("new user test package costs 10 fen and snapshots 5 AI generations", async () => {
  let gatewayInput;
  let orderInsert;
  const encryptedOpenid = encryptOpenid(OPENID, SECRET);
  const { pool } = clientPool((sql, parameters) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM pindou_orders") && !sql.includes("JOIN pindou_users")) return { rows: [] };
    if (sql.includes("FROM pindou_packages")) {
      return { rows: [packageRow({
        id: "ai_generation_new_user_5",
        label: "新人测试福利 · AI 生成 5 次",
        quota_amount: 5,
        price_fen: 10,
      })] };
    }
    if (sql.includes("FROM pindou_users")) return { rows: [{ openid_ciphertext: encryptedOpenid }] };
    if (sql.includes("INSERT INTO pindou_orders")) {
      orderInsert = parameters;
      return { rows: [] };
    }
    if (sql.includes("UPDATE pindou_orders") && sql.includes("wx_prepay_id")) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const service = new PostgresPaymentService(pool, fakeGateway({
    async createPayment(input) {
      gatewayInput = input;
      return { prepayId: "wx_prepay_test", payment: paymentParameters() };
    },
  }), SECRET, () => NOW);

  await service.createPayment({
    userId: "usr_new_user",
    packageId: "ai_generation_new_user_5",
    idempotencyKey: "new-user-test-1",
  });

  assert.equal(gatewayInput.amountFen, 10);
  assert.equal(gatewayInput.description, "小露拼豆-新人测试福利 · AI 生成 5 次");
  assert.equal(orderInsert[4], 5);
  assert.equal(orderInsert[7], 10);
});

test("new user test package is rejected after any paid AI purchase", async () => {
  const encryptedOpenid = encryptOpenid(OPENID, SECRET);
  let gatewayCalled = false;
  const state = clientPool((sql) => {
    if (sql === "BEGIN" || sql === "ROLLBACK" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM pindou_orders") && !sql.includes("JOIN pindou_users")) {
      if (sql.includes("status = 'paid'")) return { rows: [{ id: "order_paid" }] };
      return { rows: [] };
    }
    if (sql.includes("FROM pindou_packages")) {
      return { rows: [packageRow({
        id: "ai_generation_new_user_5",
        label: "新人测试福利 · AI 生成 5 次",
        quota_amount: 5,
        price_fen: 10,
      })] };
    }
    if (sql.includes("FROM pindou_users")) return { rows: [{ openid_ciphertext: encryptedOpenid }] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const service = new PostgresPaymentService(state.pool, fakeGateway({
    async createPayment() {
      gatewayCalled = true;
      throw new Error("gateway should not be called");
    },
  }), SECRET, () => NOW);

  await assert.rejects(
    () => service.createPayment({
      userId: "usr_existing_customer",
      packageId: "ai_generation_new_user_5",
      idempotencyKey: "new-user-test-2",
    }),
    (error) => error.code === "NEW_USER_PACKAGE_NOT_ELIGIBLE",
  );
  assert.equal(gatewayCalled, false);
  assert.ok(state.calls.some((call) => call.sql === "ROLLBACK"));
});

function notificationHarness(notificationOverrides = {}, options = {}) {
  const order = {
    id: "order_test",
    user_id: "usr_a",
    package_id: "ai_generation_30",
    package_label_snapshot: "AI 精致生成 30 次",
    quota_amount_snapshot: 30,
    quota_kind_snapshot: "ai_generation",
    membership_type_snapshot: null,
    price_fen: 990,
    status: "pending",
    wx_prepay_id: "wx_prepay_test",
    wx_transaction_id: null,
    openid_ciphertext: encryptOpenid(OPENID, SECRET),
  };
  let grant = null;
  let orderUpdates = 0;
  const gateway = fakeGateway({
    verifyNotification() {
      return { ...fakeGateway().verifyNotification(), ...notificationOverrides };
    },
  });
  const state = clientPool((sql, parameters) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("FROM pindou_orders orders")) return { rows: options.missingOrder ? [] : [{ ...order }] };
    if (sql.includes("SELECT id") && sql.includes("pindou_quota_transactions")) {
      return { rows: grant ? [{ id: grant.id }] : [] };
    }
    if (sql.includes("UPDATE pindou_orders") && sql.includes("status = 'paid'")) {
      order.status = "paid";
      order.wx_transaction_id = parameters[1];
      orderUpdates += 1;
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO pindou_quota_transactions")) {
      grant = { id: parameters[0], quotaKind: parameters[2], amount: parameters[3], orderId: parameters[4] };
      return { rows: [{ id: grant.id }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return {
    service: new PostgresPaymentService(state.pool, gateway, SECRET, () => NOW),
    state,
    order,
    get grant() { return grant; },
    get orderUpdates() { return orderUpdates; },
  };
}

test("successful callback atomically marks paid and duplicate callback does not grant twice", async () => {
  const harness = notificationHarness();
  const first = await harness.service.handleNotification({ rawBody: "{}", headers: {} });
  const second = await harness.service.handleNotification({ rawBody: "{}", headers: {} });
  assert.deepEqual(first, { duplicate: false });
  assert.deepEqual(second, { duplicate: true });
  assert.equal(harness.order.status, "paid");
  assert.equal(harness.orderUpdates, 1);
  assert.deepEqual(
    { quotaKind: harness.grant.quotaKind, amount: harness.grant.amount, orderId: harness.grant.orderId },
    { quotaKind: "ai_generation", amount: 30, orderId: "order_test" },
  );
  assert.equal(harness.state.calls.filter((call) => call.sql.includes("INSERT INTO pindou_quota_transactions")).length, 1);
});

test("tampered callback amount rolls back without changing order or quota", async () => {
  const harness = notificationHarness({ amountFen: 1 });
  await assert.rejects(
    () => harness.service.handleNotification({ rawBody: "{}", headers: {} }),
    (error) => error.code === "PAYMENT_ORDER_MISMATCH",
  );
  assert.equal(harness.order.status, "pending");
  assert.equal(harness.grant, null);
  assert.ok(harness.state.calls.some((call) => call.sql === "ROLLBACK"));
});

test("failed payment state never grants quota", async () => {
  const harness = notificationHarness({ eventType: "TRANSACTION.CLOSED", tradeState: "CLOSED" });
  await assert.rejects(
    () => harness.service.handleNotification({ rawBody: "{}", headers: {} }),
    (error) => error.code === "PAYMENT_STATE_INVALID",
  );
  assert.equal(harness.order.status, "pending");
  assert.equal(harness.grant, null);
});

test("notification for a missing order is rejected without a grant", async () => {
  const harness = notificationHarness({}, { missingOrder: true });
  await assert.rejects(
    () => harness.service.handleNotification({ rawBody: "{}", headers: {} }),
    (error) => error.code === "NOT_FOUND",
  );
  assert.equal(harness.grant, null);
});

test("signature failure is rejected before opening a database transaction", async () => {
  const state = clientPool(() => { throw new Error("database must not be used"); });
  const gateway = fakeGateway({
    verifyNotification() {
      throw new AppError(401, "PAYMENT_NOTIFY_SIGNATURE_INVALID", "微信支付签名校验失败");
    },
  });
  const service = new PostgresPaymentService(state.pool, gateway, SECRET, () => NOW);
  await assert.rejects(
    () => service.handleNotification({ rawBody: "{}", headers: {} }),
    (error) => error.code === "PAYMENT_NOTIFY_SIGNATURE_INVALID",
  );
  assert.equal(state.connectCount, 0);
});
