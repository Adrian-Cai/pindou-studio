const {
  assert,
  test,
  PostgresPaymentService,
  NOW,
  captureConsole,
  reconcileService,
  refundPool,
  refundInput,
  refundService
} = require("./payment-test-helpers.js");

test("refund claws back only the quota the user has not consumed", async () => {
  const pool = refundPool({ purchasedRemaining: 8 });
  const capture = captureConsole();
  try {
    const outcome = await refundService(pool).handleRefund(refundInput());
    assert.equal(outcome.applied, true);
    assert.equal(outcome.clawedBack, 8);
    assert.equal(pool.updates.length, 1);
    // 流水金额必须是负数（扣减），且等于实际扣回量而不是发放量
    assert.equal(pool.inserts.length, 1);
    assert.equal(pool.inserts[0][3], -8);
    const applied = capture.warnings.filter((entry) => entry.event === "virtual_payment_refund_applied");
    assert.equal(applied[0].grantedAmount, 30);
    assert.equal(applied[0].consumed, 22);
  } finally {
    capture.restore();
  }
});

test("a fully consumed purchase is still marked refunded but claws back nothing", async () => {
  const pool = refundPool({ purchasedRemaining: 0 });
  const capture = captureConsole();
  try {
    const outcome = await refundService(pool).handleRefund(refundInput());
    assert.equal(outcome.applied, true);
    assert.equal(outcome.clawedBack, 0);
    // 订单必须仍然置为 refunded：不能因为扣不回额度就不记账，否则订单永远停在 paid
    assert.equal(pool.updates.length, 1);
    assert.equal(pool.inserts.length, 0);
  } finally {
    capture.restore();
  }
});

test("a failed refund leaves both the order and the quota untouched", async () => {
  const pool = refundPool();
  const capture = captureConsole();
  try {
    const outcome = await refundService(pool).handleRefund(refundInput({ retCode: 1, retMsg: "余额不足" }));
    assert.equal(outcome.applied, false);
    // 退款失败还扣额度，等于用户既没拿回钱也没了商品
    assert.equal(pool.updates.length, 0);
    assert.equal(pool.inserts.length, 0);
  } finally {
    capture.restore();
  }
});

test("refund fact for a pending order first records the payment then refunds its quota", async () => {
  const pool = refundPool({ order: { status: "pending" } });
  const capture = captureConsole();
  try {
    const outcome = await refundService(pool).handleRefund(refundInput());
    assert.equal(outcome.applied, true);
    assert.equal(outcome.clawedBack, 30);
    assert.equal(pool.orderRow.status, "refunded");
    assert.equal(pool.inserts.length, 2);
    assert.equal(pool.inserts[0][3], 30);
    assert.equal(pool.inserts[1][3], -30);
  } finally {
    capture.restore();
  }
});

test("a repeated refund push is idempotent", async () => {
  const pool = refundPool({ purchasedRemaining: 8 });
  const capture = captureConsole();
  try {
    const service = refundService(pool);
    const first = await service.handleRefund(refundInput());
    assert.equal(first.applied, true);
    const second = await service.handleRefund(refundInput());
    assert.equal(second.applied, false);
    assert.equal(pool.inserts.length, 1);
  } finally {
    capture.restore();
  }
});

test("refund locates the order by the merchant trade number without raising an alert", async () => {
  const pool = refundPool({ purchasedRemaining: 8 });
  const capture = captureConsole();
  try {
    const outcome = await refundService(pool)
      .handleRefund(refundInput({ mchOrderId: "vpay_refundtradeno0001", attach: null }));
    assert.equal(outcome.applied, true);
    assert.equal(
      capture.errors.filter((entry) => entry.event === "virtual_payment_refund_alert").length,
      0,
    );
  } finally {
    capture.restore();
  }
});

test("refund falls back to attach when the merchant order id is absent", async () => {
  // iOS 退款通知只保证带 attach，不一定回传商户单号
  const pool = refundPool({ purchasedRemaining: 30 });
  const capture = captureConsole();
  try {
    const outcome = await refundService(pool)
      .handleRefund(refundInput({ mchOrderId: null, attach: "order_test" }));
    assert.equal(outcome.applied, true);
  } finally {
    capture.restore();
  }
});

test("a refund that cannot be located is reported instead of silently dropped", async () => {
  const pool = refundPool();
  const capture = captureConsole();
  try {
    const outcome = await refundService(pool)
      .handleRefund(refundInput({ mchOrderId: null, attach: null }));
    assert.equal(outcome.applied, false);
    const alerts = capture.errors.filter((entry) => entry.event === "virtual_payment_refund_alert");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].reason, "order_unlocatable");
  } finally {
    capture.restore();
  }
});

test("iOS refund query rejects the refund for an already delivered order", async () => {
  const pool = refundPool({ purchasedRemaining: 12 });
  const answer = await reconcileService(pool).answerIosRefundQuery({
    refundTimeSeconds: Math.floor(NOW.getTime() / 1000),
    channelBill: "apple_bill_1",
    productId: "product_30",
    count: 1,
    refundRequestReason: " unintended purchase",
    provideStatus: 1,
    payOrderId: "order_test",
  });
  assert.equal(answer.resultCode, 1);
  // evidence 是必填的举证材料，空着等于放弃举证
  assert.match(answer.evidence, /30 次/);
  assert.match(answer.evidence, /剩余 12 次/);
});

test("iOS refund query allows the refund when nothing was delivered", async () => {
  const pool = refundPool({ order: { status: "pending" } });
  const answer = await reconcileService(pool).answerIosRefundQuery({ payOrderId: "order_test" });
  assert.equal(answer.resultCode, 0);
  assert.match(answer.evidence, /尚未交付/);
});

test("iOS refund query allows refunds when the order is unknown or cannot be attributed", async () => {
  const cases = [
    {
      pool: refundPool({ missingOrder: true }),
      input: { payOrderId: "order_missing" },
      resultInfo: "未查询到对应订单，不主张拒绝退款",
    },
    {
      pool: refundPool(),
      input: { payOrderId: null },
      resultInfo: "无法定位订单，不主张拒绝退款",
    },
  ];
  for (const { pool, input, resultInfo } of cases) {
    const answer = await reconcileService(pool).answerIosRefundQuery(input);
    assert.equal(answer.resultCode, 0);
    assert.equal(answer.resultInfo, resultInfo);
  }
});
