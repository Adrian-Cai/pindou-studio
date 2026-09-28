const {
  assert,
  test,
  PostgresPaymentService,
  NOW,
  SECRET,
  OPENID,
  fakeVirtualGateway,
  fakeLegacyGateway,
  deliveryPool,
  deliveryInput
} = require("./payment-test-helpers.js");

test("delivery grants quota once and a duplicate notification does not grant twice", async () => {
  const pool = deliveryPool();
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);

  const first = await service.handleDelivery(deliveryInput());
  assert.equal(first.duplicate, false);
  assert.equal(pool.updates.length, 1);
  assert.equal(pool.updates[0][0], "order_test");
  assert.equal(pool.inserts.length, 1);
  assert.equal(pool.inserts[0][3], 30);

  // 第二次：订单已是 paid，应当识别为重复且不再写入流水
  const second = await service.handleDelivery(deliveryInput());
  assert.equal(second.duplicate, true);
  assert.equal(pool.inserts.length, 1);
});

test("a late verified virtual payment can settle an order closed locally after expiry", async () => {
  const pool = deliveryPool({ status: "closed" });
  const gateway = fakeVirtualGateway({
    async queryOrder() {
      return {
        paid: true,
        state: "PAID",
        mchOrderNo: "mch_order_1",
        transactionId: "transaction_late",
        paidTimeSeconds: Math.floor(NOW.getTime() / 1000),
        actualPriceFen: 990,
      };
    },
  });
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);

  const outcome = await service.handleDelivery(deliveryInput());

  assert.equal(outcome.duplicate, false);
  assert.equal(pool.orderRow.status, "paid");
  assert.equal(pool.inserts.length, 1);
});

test("delivery refuses to grant when the server-side query does not confirm payment", async () => {
  const pool = deliveryPool();
  const gateway = fakeVirtualGateway({
    async queryOrder() {
      return { paid: false, mchOrderNo: null, transactionId: null, paidTimeSeconds: null, actualPriceFen: null };
    },
  });
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);

  // 返回 duplicate=true 而非抛错：让平台停止重试，避免同一笔未付款被重试 15 次
  assert.deepEqual(await service.handleDelivery(deliveryInput()), { duplicate: true });
  assert.equal(pool.inserts.length, 0);
});

test("delivery rejects a forged payer that does not own the order", async () => {
  const pool = deliveryPool();
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.handleDelivery(deliveryInput({ openId: "attacker-openid" })),
    /付款人与订单归属不一致/,
  );
  assert.equal(pool.inserts.length, 0);
});

test("delivery rejects a mismatch between paid amount and order snapshot", async () => {
  const pool = deliveryPool();
  const gateway = fakeVirtualGateway({
    async queryOrder() {
      return {
        paid: true,
        mchOrderNo: "mch_order_1",
        transactionId: "transaction_1",
        paidTimeSeconds: Math.floor(NOW.getTime() / 1000),
        // 用户实际只付了 1 分却想领 990 分的套餐
        actualPriceFen: 1,
      };
    },
  });
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(() => service.handleDelivery(deliveryInput()), /支付金额与订单不符/);
  assert.equal(pool.inserts.length, 0);
});

test("delivery for a missing order is rejected without a grant", async () => {
  const pool = deliveryPool({ id: "order_other", virtual_out_trade_no: "vpay_other000000001" });
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(() => service.handleDelivery(deliveryInput()), /支付订单不存在/);
  // 订单都查不到，绝不能出现任何 UPDATE/INSERT
  assert.equal(pool.calls.some((call) => call.sql.includes("UPDATE pindou_orders")), false);
});

test("delivery without order identifier is rejected before any query", async () => {
  const pool = deliveryPool();
  let queried = false;
  const gateway = fakeVirtualGateway({
    async queryOrder() { queried = true; return { paid: true }; },
  });
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.handleDelivery(deliveryInput({ outTradeNo: "  " })),
    /缺少 openid 或订单号/,
  );
  assert.equal(queried, false);
});

test("delivery locates the order by the merchant trade number, which is no longer the order id", async () => {
  const pool = deliveryPool();
  let queried = null;
  const gateway = fakeVirtualGateway({
    async queryOrder(input) {
      queried = input.outTradeNo;
      return {
        paid: true,
        mchOrderNo: "mch_order_1",
        transactionId: "transaction_1",
        paidTimeSeconds: Math.floor(NOW.getTime() / 1000),
        actualPriceFen: 990,
      };
    },
  });
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  const result = await service.handleDelivery(deliveryInput({ outTradeNo: "vpay_existingtradeno00001" }));

  assert.equal(result.duplicate, false);
  // 查单必须带上商户单号：订单号在微信侧压根不存在
  assert.equal(queried, "vpay_existingtradeno00001");
  // 但发放必须落在订单号上
  assert.equal(pool.updates[0][0], "order_test");
  assert.equal(pool.inserts.length, 1);
});

test("delivery for an unknown merchant trade number is rejected without a grant", async () => {
  const pool = deliveryPool();
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.handleDelivery(deliveryInput({ outTradeNo: "vpay_notissuedatall0001" })),
    /支付订单不存在/,
  );
  assert.equal(pool.inserts.length, 0);
});

test("legacy notification still settles in-flight orders from the previous channel", async () => {
  const pool = deliveryPool();
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  const result = await service.handleNotification({ rawBody: "{}", headers: {} });
  assert.equal(result.duplicate, false);
  assert.equal(pool.inserts.length, 1);
});

/** 补单轮询的调度参数：静默期 3 分钟、兜底窗口 30 分钟、关单窗口 1 小时。 */
