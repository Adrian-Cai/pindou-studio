const {
  assert,
  test,
  PostgresPaymentService,
  NOW,
  clientPool,
  fakeVirtualGateway,
  deliveryPool,
  RECONCILE_OPTIONS,
  candidateRow,
  UNPAID_QUERY,
  captureConsole,
  reconcileService
} = require("./payment-test-helpers.js");

test("reconcile grants quota when the delivery push never arrived", async () => {
  const pool = deliveryPool({}, [candidateRow("order_test", 10 * 60_000)]);
  const capture = captureConsole();
  try {
    const summary = await reconcileService(pool).reconcilePendingOrders();
    assert.equal(summary.scanned, 1);
    assert.equal(summary.granted, 1);
    assert.deepEqual(summary.attention, []);
    // 发放结果必须与发货推送路径一致：一条 purchase_grant 流水，金额取自订单快照
    assert.equal(pool.inserts.length, 1);
    assert.equal(pool.inserts[0][3], 30);
    // 走到这里说明推送确实丢过一次，必须留下可追踪的 warn 痕迹
    const recovered = capture.warnings.filter((entry) => entry.event === "virtual_payment_delivery_recovered");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].orderId, "order_test");
  } finally {
    capture.restore();
  }
});

test("reconcile queries wechat with the merchant trade number instead of the order id", async () => {
  const pool = deliveryPool({}, [candidateRow("order_test", 10 * 60_000)]);
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
  const capture = captureConsole();
  try {
    const summary = await reconcileService(pool, gateway).reconcilePendingOrders();
    assert.equal(summary.granted, 1);
    // 拿订单号去查单只会得到「单号不存在」，于是每一笔在途订单都被误判成没付款
    assert.equal(queried, "vpay_order_test");
  } finally {
    capture.restore();
  }
});

test("reconcile retries unknown attempts only after the retry grace period", async () => {
  const pool = deliveryPool({}, [candidateRow("order_test", 60_000)]);
  const capture = captureConsole();
  try {
    await reconcileService(pool).reconcilePendingOrders();
    const scan = pool.calls.find((call) => call.sql.includes("attempts.id AS attempt_id"));
    assert.match(scan.sql, /attempts\.status = 'ISSUED' AND orders\.expires_at <= \$1/);
    assert.match(scan.sql, /attempts\.status = 'UNKNOWN'/);
    assert.match(scan.sql, /attempts\.last_query_at <= \$2/);
    assert.deepEqual(scan.parameters[0], NOW);
    assert.deepEqual(scan.parameters[1], new Date(NOW.getTime() - RECONCILE_OPTIONS.graceMs));
    assert.equal(scan.parameters[2], RECONCILE_OPTIONS.batchSize);
  } finally {
    capture.restore();
  }
});

test("reconcile only scans orders wired to a virtual payment product", async () => {
  // 旧通道（商户号 + APIv3）的在途订单拿去 query_order 只会得到「单号不存在」，必须排除
  const pool = deliveryPool({}, [candidateRow("order_test", 10 * 60_000)]);
  const capture = captureConsole();
  try {
    await reconcileService(pool).reconcilePendingOrders();
    const scan = pool.calls.find((call) => call.sql.includes("attempts.id AS attempt_id"));
    assert.match(scan.sql, /JOIN pindou_payment_attempts/);
    assert.match(scan.sql, /attempts\.status IN \('ISSUED', 'UNKNOWN'\)/);
    assert.match(scan.sql, /status = 'pending'/);
  } finally {
    capture.restore();
  }
});

test("an unpaid order inside the stale window stays pending without alerting", async () => {
  const pool = deliveryPool({}, [candidateRow("order_test", 2 * 60_000)]);
  const gateway = fakeVirtualGateway({ async queryOrder() { return UNPAID_QUERY; } });
  const capture = captureConsole();
  try {
    const summary = await reconcileService(pool, gateway).reconcilePendingOrders();
    assert.equal(summary.unpaid, 1);
    assert.deepEqual(summary.attention, []);
    assert.equal(pool.inserts.length, 0);
    assert.equal(capture.errors.length, 0);
  } finally {
    capture.restore();
  }
});

test("an unknown payment state past the stale window raises a reconcile alert", async () => {
  const pool = deliveryPool({}, [candidateRow("order_test", 45 * 60_000)]);
  const gateway = fakeVirtualGateway({ async queryOrder() { return { ...UNPAID_QUERY, state: "UNKNOWN" }; } });
  const capture = captureConsole();
  try {
    const summary = await reconcileService(pool, gateway).reconcilePendingOrders();
    assert.equal(summary.stalled, 1);
    assert.deepEqual(summary.attention, ["order_test"]);
    const alerts = capture.errors.filter((entry) => entry.event === "virtual_payment_reconcile_alert");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].reason, "provider_status_unknown");
    assert.equal(alerts[0].orderId, "order_test");
  } finally {
    capture.restore();
  }
});

test("a confirmed unpaid order closes immediately after its five-minute expiry", async () => {
  const pool = deliveryPool({}, [candidateRow("order_test", 5 * 60_000 + 1)]);
  const gateway = fakeVirtualGateway({ async queryOrder() { return UNPAID_QUERY; } });
  const capture = captureConsole();
  try {
    const summary = await reconcileService(pool, gateway).reconcilePendingOrders();
    assert.equal(summary.closed, 1);
    assert.equal(summary.stalled, 0);
    assert.deepEqual(summary.attention, []);
    assert.equal(pool.orderRow.status, "closed");
    assert.equal(pool.attempt.status, "CLOSED");
    const attemptUpdate = pool.calls.find(({ sql }) => sql.includes("query_count = query_count + 1"));
    assert.ok(attemptUpdate);
    assert.match(attemptUpdate.sql, /status = \$2::varchar/);
    assert.match(attemptUpdate.sql, /CASE WHEN \$2::varchar = 'CLOSED'/);
    assert.match(pool.updateSql[0], /status = 'closed'/);
    assert.match(pool.updateSql[0], /AND status = 'pending'/);
    assert.equal(
      capture.warnings.filter((entry) => entry.event === "virtual_payment_order_closed").length,
      1,
    );
  } finally {
    capture.restore();
  }
});

test("an unknown payment result remains pending after the close window", async () => {
  const pool = deliveryPool({}, [candidateRow("order_test", 90 * 60_000)]);
  const gateway = fakeVirtualGateway({ async queryOrder() { throw new Error("provider timeout"); } });
  const capture = captureConsole();
  try {
    const summary = await reconcileService(pool, gateway).reconcilePendingOrders();
    assert.equal(summary.closed, 0);
    assert.equal(summary.unresolved, 1);
    assert.equal(pool.orderRow.status, "pending");
    assert.equal(pool.updates.length, 0);
  } finally {
    capture.restore();
  }
});

test("a provider-confirmed closed attempt closes the local order", async () => {
  const pool = deliveryPool({}, [candidateRow("order_test", 90 * 60_000)]);
  const gateway = fakeVirtualGateway({ async queryOrder() { return { ...UNPAID_QUERY, state: "CLOSED" }; } });
  const capture = captureConsole();
  try {
    const summary = await reconcileService(pool, gateway).reconcilePendingOrders();
    assert.equal(summary.closed, 1);
    assert.equal(summary.stalled, 0);
    assert.deepEqual(summary.attention, []);
    assert.equal(pool.orderRow.status, "closed");
    assert.equal(
      capture.errors.filter((entry) => entry.event === "virtual_payment_reconcile_alert").length,
      0,
    );
  } finally {
    capture.restore();
  }
});

test("closing an order only touches rows still pending", async () => {
  const pool = deliveryPool({}, [candidateRow("order_test", 90 * 60_000)]);
  const gateway = fakeVirtualGateway({ async queryOrder() { return { ...UNPAID_QUERY, state: "CLOSED" }; } });
  const capture = captureConsole();
  try {
    await reconcileService(pool, gateway).reconcilePendingOrders();
    assert.equal(pool.updates.length, 1);
    assert.equal(pool.updates[0][0], "order_test");
    // 唯一能守住「不覆盖已支付订单」的是这条 WHERE：并发下订单可能刚被置为 paid
    assert.match(pool.updateSql[0], /status = 'closed'/);
    assert.match(pool.updateSql[0], /AND status = 'pending'/);
  } finally {
    capture.restore();
  }
});

test("an unpaid order inside the stale window stays pending without closing", async () => {
  const pool = deliveryPool({}, [candidateRow("order_test", 2 * 60_000)]);
  const gateway = fakeVirtualGateway({ async queryOrder() { return UNPAID_QUERY; } });
  const capture = captureConsole();
  try {
    const summary = await reconcileService(pool, gateway).reconcilePendingOrders();
    assert.equal(summary.unpaid, 1);
    assert.equal(summary.closed, 0);
    assert.deepEqual(pool.updates, [], "未过窗口的订单绝不能被动状态");
  } finally {
    capture.restore();
  }
});

test("a failing query is counted unresolved and does not abort the batch", async () => {
  const pool = deliveryPool({}, [
    candidateRow("order_first", 10 * 60_000),
    candidateRow("order_test", 10 * 60_000),
  ]);
  const gateway = fakeVirtualGateway({
    async queryOrder(input) {
      if (input.outTradeNo === "vpay_order_first") throw new Error("虚拟支付服务暂时不可用");
      return {
        paid: true,
        mchOrderNo: "mch_order_1",
        transactionId: "transaction_1",
        paidTimeSeconds: Math.floor(NOW.getTime() / 1000),
        actualPriceFen: 990,
      };
    },
  });
  const capture = captureConsole();
  try {
    const summary = await reconcileService(pool, gateway).reconcilePendingOrders();
    assert.equal(summary.scanned, 2);
    assert.equal(summary.unresolved, 1);
    // 前一笔挂掉绝不能连累后一笔：那才是真正被欠着商品的用户
    assert.equal(summary.granted, 1);
    assert.deepEqual(summary.attention, ["order_first"]);
  } finally {
    capture.restore();
  }
});

test("a candidate without a usable payer identity is reported instead of dropped", async () => {
  const pool = deliveryPool({}, [candidateRow("order_test", 10 * 60_000, { openid_ciphertext: null })]);
  const capture = captureConsole();
  try {
    const summary = await reconcileService(pool).reconcilePendingOrders();
    assert.equal(summary.skipped, 1);
    assert.deepEqual(summary.attention, ["order_test"]);
    const alerts = capture.errors.filter((entry) => entry.event === "virtual_payment_reconcile_alert");
    assert.equal(alerts[0].reason, "payer_identity_unavailable");
  } finally {
    capture.restore();
  }
});

test("reconcile is a no-op when the virtual gateway is not configured", async () => {
  let queryCount = 0;
  const pool = clientPool(() => {
    queryCount += 1;
    return { rows: [] };
  });
  const gateway = fakeVirtualGateway({ configured: false });
  const capture = captureConsole();
  try {
    const summary = await reconcileService(pool, gateway).reconcilePendingOrders();
    assert.equal(summary.scanned, 0);
    // 未配置时扫一遍只会空转并打出误导性的日志
    assert.equal(queryCount, 0);
  } finally {
    capture.restore();
  }
});

/** 构造退款所需的假 Pool：订单默认已支付，购买额度剩余量可指定。 */
