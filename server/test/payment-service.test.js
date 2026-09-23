const assert = require("node:assert/strict");
const test = require("node:test");
const { encryptOpenid, encryptSessionKey } = require("../dist/shared/identity.js");
const { PostgresPaymentService } = require("../dist/modules/payments/payment-service.js");

const NOW = new Date("2026-08-31T12:00:00.000Z");
const SECRET = "test_openid_hash_secret_32_characters_long";
const OPENID = "payer-openid-private";
const SESSION_KEY = "test-session-key";

/**
 * 直接返回具备 connect/query 的假 Pool（不再包一层 { pool }）。
 *
 * 早期版本返回 `{ pool, calls }` 再在各用例里 `.pool` 解包，结果同一文件里出现了
 * 两种传参写法，批量替换时极易双重解包或漏解包。这里统一返回本体，附带信息挂在属性上。
 */
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
    async connect() { connectCount += 1; return client; },
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      return handler(sql, parameters, calls);
    },
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
    virtual_product_id: "product_30",
    ...overrides,
  };
}

/** 虚拟支付网关桩：默认「已支付」，可通过 overrides 改成未支付或抛错。 */
function fakeVirtualGateway(overrides = {}) {
  return {
    configured: true,
    offerId: "offer-test",
    createPayment(input) {
      return {
        signData: JSON.stringify({ outTradeNo: input.orderId, productId: input.productId }),
        paySig: "pay-sig",
        signature: "user-sig",
        mode: "short_series_goods",
      };
    },
    async queryOrder() {
      return {
        paid: true,
        mchOrderNo: "mch_order_1",
        transactionId: "transaction_1",
        paidTimeSeconds: Math.floor(NOW.getTime() / 1000),
        actualPriceFen: 990,
      };
    },
    ...overrides,
  };
}

/** 旧通道网关桩：仅用于验证存量兜底路径，正常不应再参与新订单。 */
function fakeLegacyGateway(overrides = {}) {
  return {
    configured: true,
    appId: "wx-app",
    merchantId: "mch-123",
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

const ENCRYPTED_OPENID = encryptOpenid(OPENID, SECRET);
const ENCRYPTED_SESSION_KEY = encryptSessionKey(SESSION_KEY, SECRET);

/** 构造下单所需的假 Pool：按 SQL 片段返回对应行。返回对象自带 orderInsert 便于断言。 */
function createPaymentPool(packageOverrides = {}, userOverrides = {}) {
  const orderInsert = [];
  const pool = clientPool((sql, parameters) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM pindou_orders")) return { rows: [] };
    if (sql.includes("FROM pindou_packages")) return { rows: [packageRow(packageOverrides)] };
    if (sql.includes("FROM pindou_users") && sql.includes("SELECT openid_ciphertext, session")) {
      return { rows: [{ openid_ciphertext: ENCRYPTED_OPENID, session_key_ciphertext: ENCRYPTED_SESSION_KEY }] };
    }
    if (sql.includes("INSERT INTO pindou_orders")) { pool.orderInsert.push(parameters); return { rows: [] }; }
    if (sql.includes("UPDATE pindou_orders")) return { rows: [] };
    if (sql.includes("SELECT session_key_ciphertext")) {
      return { rows: [{ session_key_ciphertext: userOverrides.sessionKeyCiphertext === undefined ? ENCRYPTED_SESSION_KEY : userOverrides.sessionKeyCiphertext }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  pool.orderInsert = orderInsert;
  return pool;
}

test("packages returns only the enabled rows selected by the server query", async () => {
  const { calls, ...pool } = clientPool(() => ({ rows: [packageRow()] }));
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
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
  const pool = clientPool(() => ({ rows: [packageRow({ membership_type: "monthly" })] }));
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(() => service.listPackages(), /数据库套餐不符合支付业务约束/);
});

test("payment creation snapshots server package values and never accepts a client amount", async () => {
  let virtualInput;
  const gateway = fakeVirtualGateway({
    createPayment(input) {
      virtualInput = input;
      return {
        signData: JSON.stringify({ outTradeNo: input.orderId, productId: input.productId }),
        paySig: "pay-sig",
        signature: "user-sig",
        mode: "short_series_goods",
      };
    },
  });
  const pool = createPaymentPool();
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  const result = await service.createPayment({
    userId: "usr_a",
    packageId: "ai_generation_30",
    idempotencyKey: "create-starter-1",
  });

  assert.match(result.orderId, /^order_[a-f0-9]{26}$/);
  // 旧通道参数必须不再下发，避免客户端误用 wx.requestPayment
  assert.equal(result.payment, null);
  assert.equal(virtualInput.orderId, result.orderId);
  assert.equal(virtualInput.productId, "product_30");
  assert.equal(virtualInput.goodsPriceFen, 990);
  assert.equal(virtualInput.sessionKey, SESSION_KEY);
  // 订单快照来自服务端套餐表，客户端无法改写金额
  assert.equal(pool.orderInsert[0][3], "AI 精致生成 30 次");
  assert.equal(pool.orderInsert[0][4], 30);
  assert.equal(pool.orderInsert[0][5], "ai_generation");
  assert.equal(pool.orderInsert[0][7], 990);
});

test("order id satisfies the virtual payment outTradeNo contract", async () => {
  const pool = createPaymentPool();
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  const result = await service.createPayment({
    userId: "usr_a",
    packageId: "ai_generation_30",
    idempotencyKey: "length-boundary-check",
  });
  // 虚拟支付限制：8-32 位、仅数字字母与 _ - | * @、不以 _ 开头
  assert.match(result.orderId, /^[A-Za-z0-9][A-Za-z0-9_\-|*@]{7,31}$/);
  assert.ok(result.orderId.length <= 32);
});

test("package without a virtual product id is rejected before any payment parameters are signed", async () => {
  const pool = createPaymentPool({ virtual_product_id: null });
  let signed = false;
  const gateway = fakeVirtualGateway({
    createPayment() { signed = true; return {}; },
  });
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.createPayment({
      userId: "usr_a",
      packageId: "ai_generation_30",
      idempotencyKey: "no-product",
    }),
    /套餐未配置虚拟支付道具/,
  );
  assert.equal(signed, false);
});

test("missing session key blocks signing with an actionable message", async () => {
  const pool = createPaymentPool({}, { sessionKeyCiphertext: null });
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.createPayment({
      userId: "usr_a",
      packageId: "ai_generation_30",
      idempotencyKey: "no-session",
    }),
    /请重新登录后支付/,
  );
});

test("new user test package is rejected after any paid AI purchase", async () => {
  const pool = clientPool((sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    // 新人限购查询必须**先于**通用的 orders 兜底分支命中：它也查 pindou_orders，
    // 一旦被上面的空行分支吃掉，限购校验就形同虚设。
    if (sql.includes("status = 'paid'")) return { rows: [{ found: 1 }] };
    if (sql.includes("FROM pindou_orders") && !sql.includes("JOIN pindou_users")) return { rows: [] };
    if (sql.includes("FROM pindou_packages")) {
      return { rows: [packageRow({ id: "ai_generation_new_user_5", price_fen: 10, quota_amount: 5 })] };
    }
    // 正常走到这里说明限购校验没拦住；补 user 查询分支只会掩盖断言失败，
    // 因此对 users 查询返回空并于下面的抛错暴露真实原因。
    if (sql.includes("FROM pindou_users")) throw new Error("限购分支未拦截，测试桩不应走到用户查询");
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.createPayment({
      userId: "usr_a",
      packageId: "ai_generation_new_user_5",
      idempotencyKey: "second-purchase",
    }),
    /仅限首次购买/,
  );
});

/** 构造发货所需的假 Pool：返回一笔 pending 订单。
 *
 * 第二参数 `candidates` 用于补单轮询：给定时，「扫描待发货订单」那条查询会返回它们，
 * 之后的发放链路与发货推送完全共用同一份假实现 —— 两条支路本来就该走同一套幂等逻辑。
 */
function deliveryPool(orderOverrides = {}, candidates = null) {
  const updates = [];
  const inserts = [];
  const orderRow = {
    id: "order_test",
    user_id: "usr_a",
    package_id: "ai_generation_30",
    package_label_snapshot: "AI 精致生成 30 次",
    quota_amount_snapshot: 30,
    quota_kind_snapshot: "ai_generation",
    membership_type_snapshot: null,
    price_fen: 990,
    status: "pending",
    wx_prepay_id: null,
    wx_transaction_id: null,
    openid_ciphertext: ENCRYPTED_OPENID,
    ...orderOverrides,
  };
  const pool = clientPool((sql, parameters) => {
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
    if (candidates !== null && sql.includes("ORDER BY orders.created_at ASC")) return { rows: candidates };
    if (sql.includes("FOR UPDATE OF orders")) return { rows: [orderRow] };
    if (sql.includes("UPDATE pindou_orders")) {
      pool.updates.push(parameters);
      // 让假 Pool 具备真实语义：订单一旦置为 paid，后续读取必须看到 paid，
      // 否则「重复发货应被识别为 duplicate」这条断言永远测不到真实行为。
      orderRow.status = "paid";
      orderRow.wx_transaction_id = parameters[1];
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO pindou_quota_transactions")) {
      pool.inserts.push(parameters);
      return { rows: [{ id: "qt_grant_1" }] };
    }
    // 已有 granting 流水时返回行，用于复现「重复通知不再发放」
    if (sql.includes("FROM pindou_quota_transactions")) {
      return { rows: pool.inserts.length > 0 ? [{ id: "qt_grant_1" }] : [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  pool.updates = updates;
  pool.inserts = inserts;
  return pool;
}

function deliveryInput(overrides = {}) {
  return {
    openId: OPENID,
    outTradeNo: "order_test",
    env: 0,
    mchOrderNo: "mch_order_1",
    transactionId: "transaction_1",
    paidTimeSeconds: Math.floor(NOW.getTime() / 1000),
    productId: "product_30",
    quantity: 1,
    actualPriceFen: 990,
    attach: "order_test",
    ...overrides,
  };
}

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
  const { calls, ...pool } = clientPool((sql) => {
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
    if (sql.includes("FOR UPDATE OF orders")) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(() => service.handleDelivery(deliveryInput()), /支付订单不存在/);
  // 订单都查不到，绝不能出现任何 UPDATE/INSERT
  assert.equal(calls.some((call) => call.sql.includes("UPDATE pindou_orders")), false);
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

test("legacy notification still settles in-flight orders from the previous channel", async () => {
  const pool = deliveryPool();
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  const result = await service.handleNotification({ rawBody: "{}", headers: {} });
  assert.equal(result.duplicate, false);
  assert.equal(pool.inserts.length, 1);
});

/** 补单轮询的调度参数：静默期 3 分钟、兜底窗口 30 分钟。 */
const RECONCILE_OPTIONS = { graceMs: 3 * 60_000, staleAfterMs: 30 * 60_000, batchSize: 10 };

/** 构造一个比 NOW 早 ageMs 的待补单候选行。 */
function candidateRow(id, ageMs, overrides = {}) {
  return {
    id,
    created_at: new Date(NOW.getTime() - ageMs),
    openid_ciphertext: ENCRYPTED_OPENID,
    ...overrides,
  };
}

/** 未付款的查单结果。 */
const UNPAID_QUERY = {
  paid: false,
  mchOrderNo: null,
  transactionId: null,
  paidTimeSeconds: null,
  actualPriceFen: null,
};

/**
 * 捕获结构化日志。
 *
 * 补单的价值一半在本体一半在告警：发了多少钱重要，**让人知道扣了款没到账**同样重要。
 * 因此下面多个用例直接断言 console.error / console.warn 的事件，而不只看返回值。
 */
function captureConsole() {
  const errors = [];
  const warnings = [];
  const original = { error: console.error, warn: console.warn, log: console.log };
  const record = (bucket) => (line) => {
    bucket.push(typeof line === "string" ? JSON.parse(line) : line);
  };
  console.error = record(errors);
  console.warn = record(warnings);
  console.log = () => undefined;
  return {
    errors,
    warnings,
    restore() {
      console.error = original.error;
      console.warn = original.warn;
      console.log = original.log;
    },
  };
}

function reconcileService(pool, gateway) {
  return new PostgresPaymentService(
    pool,
    gateway ?? fakeVirtualGateway(),
    fakeLegacyGateway(),
    SECRET,
    () => NOW,
    RECONCILE_OPTIONS,
  );
}

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

test("reconcile window is enforced server-side by the grace period", async () => {
  const pool = deliveryPool({}, [candidateRow("order_test", 60_000)]);
  const capture = captureConsole();
  try {
    await reconcileService(pool).reconcilePendingOrders();
    const scan = pool.calls.find((call) => call.sql.includes("ORDER BY orders.created_at ASC"));
    assert.match(scan.sql, /created_at <= \$1/);
    assert.deepEqual(scan.parameters[0], new Date(NOW.getTime() - RECONCILE_OPTIONS.graceMs));
    assert.equal(scan.parameters[1], RECONCILE_OPTIONS.batchSize);
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
    const scan = pool.calls.find((call) => call.sql.includes("ORDER BY orders.created_at ASC"));
    assert.match(scan.sql, /JOIN pindou_packages/);
    assert.match(scan.sql, /packages\.virtual_product_id IS NOT NULL/);
    assert.match(scan.sql, /status = 'pending'/);
  } finally {
    capture.restore();
  }
});

test("an unpaid order inside the stale window stays pending without alerting", async () => {
  const pool = deliveryPool({}, [candidateRow("order_test", 10 * 60_000)]);
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

test("an order pending past the stale window raises a reconcile alert", async () => {
  const pool = deliveryPool({}, [candidateRow("order_test", 45 * 60_000)]);
  const gateway = fakeVirtualGateway({ async queryOrder() { return UNPAID_QUERY; } });
  const capture = captureConsole();
  try {
    const summary = await reconcileService(pool, gateway).reconcilePendingOrders();
    assert.equal(summary.stalled, 1);
    assert.deepEqual(summary.attention, ["order_test"]);
    const alerts = capture.errors.filter((entry) => entry.event === "virtual_payment_reconcile_alert");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].reason, "pending_too_long");
    assert.equal(alerts[0].orderId, "order_test");
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
      if (input.orderId === "order_first") throw new Error("虚拟支付服务暂时不可用");
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
