/**
 * 订单页「继续支付 / 取消订单」两条链路的单元测试。
 *
 * 这两个入口与 createPayment 共用 resumeExistingPayment / confirmAndGrant，
 * 这里只验证各自的入口契约：
 * - 继续支付：不创建新订单；微信未关单沿用原商户单号；已付/已关/非本人各有明确回答；
 * - 取消订单：先查微信再关单 —— 已付要发货并回答 ORDER_ALREADY_PAID，
 *   查单失败绝不关单，确认未付才本地关闭。
 */
const {
  assert,
  test,
  PostgresPaymentService,
  NOW,
  SECRET,
  fakeVirtualGateway,
  fakeLegacyGateway,
  existingOrderPool,
  UNPAID_QUERY,
} = require("./payment-test-helpers.js");

function spyGateway(overrides = {}) {
  let queryCount = 0;
  const paidResult = {
    paid: true,
    mchOrderNo: "mch_order_1",
    transactionId: "transaction_1",
    paidTimeSeconds: Math.floor(NOW.getTime() / 1000),
    actualPriceFen: 990,
  };
  const gateway = fakeVirtualGateway({
    async queryOrder(...args) {
      queryCount += 1;
      if (overrides.queryOrder) return overrides.queryOrder(...args);
      return overrides.queryResult ?? paidResult;
    },
  });
  gateway.queryCallCount = () => queryCount;
  return gateway;
}

test("continue payment keeps the same order and trade number while WeChat still reports it unpaid", async () => {
  const gateway = spyGateway({ queryResult: UNPAID_QUERY });
  const pool = existingOrderPool();
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  const result = await service.continuePayment({ userId: "usr_a", orderId: "order_existing" });

  assert.equal(result.orderId, "order_existing", "继续支付必须落在原订单上");
  assert.equal(result.payment, null);
  const signed = JSON.parse(result.virtual.signData);
  assert.equal(signed.outTradeNo, "vpay_existingtradeno00001", "微信未关单时沿用原商户单号，不得换号");
  assert.equal(pool.attempts.length, 1, "不得为未关单的尝试创建新支付尝试");
  assert.equal(pool.updates.length, 0, "未关单分支不应改写订单");
});

test("continue payment issues a fresh attempt number for the same order after WeChat closed the old one", async () => {
  const gateway = spyGateway({
    queryResult: { state: "CLOSED", paid: false, mchOrderNo: null, transactionId: null, paidTimeSeconds: null, actualPriceFen: null },
  });
  const pool = existingOrderPool();
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  const result = await service.continuePayment({ userId: "usr_a", orderId: "order_existing" });

  assert.equal(result.orderId, "order_existing", "换号也必须是同一张订单");
  const signed = JSON.parse(result.virtual.signData);
  assert.notEqual(signed.outTradeNo, "vpay_existingtradeno00001");
  assert.equal(pool.attempts.length, 2, "旧尝试关闭后为同一订单签发新尝试");
  assert.equal(pool.attempts[1].status, "ISSUED");
  const orderUpdate = pool.updates.find((_, index) => pool.updateSql[index]?.includes("virtual_out_trade_no"));
  assert.ok(orderUpdate, "订单必须指向新商户单号");
  assert.equal(orderUpdate[1], signed.outTradeNo);
});

test("continue payment grants the paid order and answers ORDER_ALREADY_PAID with the order id", async () => {
  const gateway = spyGateway({});
  const pool = existingOrderPool();
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.continuePayment({ userId: "usr_a", orderId: "order_existing" }),
    (error) => error.code === "ORDER_ALREADY_PAID" && error.details.orderId === "order_existing",
  );
  assert.equal(pool.quotaInserts.length, 1, "查到微信已付时必须先补发货");
  assert.equal(pool.updates.some((_, index) => pool.updateSql[index]?.includes("status = 'paid'")), true);
});

test("continue payment rejects closed orders as expired and answers paid orders without querying WeChat", async () => {
  const closedGateway = spyGateway({});
  const closedPool = existingOrderPool({ status: "closed" });
  const closedService = new PostgresPaymentService(closedPool, closedGateway, fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => closedService.continuePayment({ userId: "usr_a", orderId: "order_existing" }),
    (error) => error.code === "ORDER_EXPIRED",
  );
  assert.equal(closedGateway.queryCallCount(), 0, "终态订单在查微信之前就能给出答案");

  const paidGateway = spyGateway({});
  const paidPool = existingOrderPool({ status: "paid" });
  const paidService = new PostgresPaymentService(paidPool, paidGateway, fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => paidService.continuePayment({ userId: "usr_a", orderId: "order_existing" }),
    (error) => error.code === "ORDER_ALREADY_PAID",
  );
  assert.equal(paidGateway.queryCallCount(), 0);
});

test("continue payment answers PAYMENT_STATUS_CONFIRMING when the WeChat query fails", async () => {
  const gateway = spyGateway({ queryOrder: async () => { throw new Error("upstream timeout"); } });
  const pool = existingOrderPool();
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.continuePayment({ userId: "usr_a", orderId: "order_existing" }),
    (error) => error.code === "PAYMENT_STATUS_CONFIRMING",
  );
  assert.equal(pool.attempts[0].status, "UNKNOWN", "查单失败后尝试必须标记为状态未知");
});

test("continue payment hides other users' orders behind not-found", async () => {
  const pool = existingOrderPool();
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.continuePayment({ userId: "usr_b", orderId: "order_existing" }),
    (error) => error.code === "NOT_FOUND",
  );
});

test("cancel closes an unpaid order locally and marks its attempt closed", async () => {
  const gateway = spyGateway({ queryResult: UNPAID_QUERY });
  const pool = existingOrderPool();
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  const result = await service.cancelOrder({ userId: "usr_a", orderId: "order_existing" });

  assert.deepEqual(result, { status: "closed" });
  const closedIndex = pool.updateSql.findIndex((sql) => sql.includes("status = 'closed'"));
  assert.ok(closedIndex >= 0, "确认未付后必须本地关单");
  assert.equal(pool.updates[closedIndex][0], "order_existing");
  assert.equal(pool.attempts[0].status, "CLOSED", "支付尝试同步关闭，维持「全关才关单」不变式");
  assert.equal(gateway.queryCallCount(), 1, "关单前必须先向微信核实真实状态");
});

test("cancel confirms and grants a WeChat-paid order instead of closing it", async () => {
  const gateway = spyGateway({});
  const pool = existingOrderPool();
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.cancelOrder({ userId: "usr_a", orderId: "order_existing" }),
    (error) => error.code === "ORDER_ALREADY_PAID" && error.details.orderId === "order_existing",
  );
  assert.equal(pool.quotaInserts.length, 1, "用户点取消时若其实已付款，必须照常发货");
  assert.equal(
    pool.updateSql.some((sql) => sql.includes("status = 'closed'")),
    false,
    "已付订单绝不能被关掉",
  );
});

test("cancel refuses to close the order when the WeChat query fails", async () => {
  const gateway = spyGateway({ queryOrder: async () => { throw new Error("wechat 5xx"); } });
  const pool = existingOrderPool();
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.cancelOrder({ userId: "usr_a", orderId: "order_existing" }),
    (error) => error.code === "PAYMENT_STATUS_CONFIRMING",
  );
  assert.equal(
    pool.updateSql.some((sql) => sql.includes("status = 'closed'")),
    false,
    "状态未知时不能关单，避免误关已付订单",
  );
  assert.equal(pool.attempts[0].status, "UNKNOWN");
});

test("cancel is idempotent for already-closed orders and hides other users' orders", async () => {
  const gateway = spyGateway({});
  const pool = existingOrderPool({ status: "closed" });
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  assert.deepEqual(await service.cancelOrder({ userId: "usr_a", orderId: "order_existing" }), { status: "closed" });
  assert.equal(gateway.queryCallCount(), 0, "已关闭的订单无需再查微信");
  assert.equal(pool.updateSql.some((sql) => sql.includes("status = 'closed'")), false);

  const ownedPool = existingOrderPool();
  const ownedService = new PostgresPaymentService(ownedPool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => ownedService.cancelOrder({ userId: "usr_b", orderId: "order_existing" }),
    (error) => error.code === "NOT_FOUND",
  );
});

test("cancel closes an expired order that WeChat still reports unpaid", async () => {
  const gateway = spyGateway({ queryResult: UNPAID_QUERY });
  const pool = existingOrderPool({ expires_at: new Date(NOW.getTime() - 1_000) });
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  const result = await service.cancelOrder({ userId: "usr_a", orderId: "order_existing" });
  assert.deepEqual(result, { status: "closed" });
  assert.equal(pool.updateSql.some((sql) => sql.includes("status = 'closed'")), true);
});
