const {
  assert,
  test,
  PostgresPaymentService,
  NOW,
  SECRET,
  SESSION_KEY,
  clientPool,
  packageRow,
  fakeVirtualGateway,
  fakeLegacyGateway,
  createPaymentPool,
  existingOrderPool,
  UNPAID_QUERY
} = require("./payment-test-helpers.js");

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
        signData: JSON.stringify({ outTradeNo: input.outTradeNo, productId: input.productId }),
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
  assert.equal(virtualInput.productId, "product_30");
  assert.equal(virtualInput.goodsPriceFen, 990);
  assert.equal(virtualInput.sessionKey, SESSION_KEY);
  // 订单快照来自服务端套餐表，客户端无法改写金额
  assert.equal(pool.orderInsert[0][3], "AI 精致生成 30 次");
  assert.equal(pool.orderInsert[0][4], 30);
  assert.equal(pool.orderInsert[0][5], "ai_generation");
  assert.equal(pool.orderInsert[0][7], 990);
  assert.equal(pool.orderInsert[0][9], "create-starter-1");
  assert.deepEqual(pool.orderInsert[0][10], new Date(NOW.getTime() + 5 * 60_000));
  assert.equal(pool.attemptInsert.length, 1);
  assert.equal(pool.attemptInsert[0][4], 990);
  // 商户单号与订单号必须分开存：它才是微信侧认识的那个号
  assert.equal(pool.orderInsert[0][8], virtualInput.outTradeNo);
  assert.notEqual(virtualInput.outTradeNo, result.orderId);
});

/**
 * 核心不变式：每个支付尝试都持有独立商户单号，单号与业务订单号分离。
 */
test("the out trade no satisfies the virtual payment contract and never equals the order id", async () => {
  const pool = createPaymentPool();
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  const result = await service.createPayment({
    userId: "usr_a",
    packageId: "ai_generation_30",
    idempotencyKey: "length-boundary-check",
  });
  const outTradeNo = JSON.parse(result.virtual.signData).outTradeNo;
  // 虚拟支付限制：8-32 位、仅数字字母与 _ - | * @、不以 _ 开头
  assert.match(outTradeNo, /^[A-Za-z0-9][A-Za-z0-9_\-|*@]{7,31}$/);
  assert.ok(outTradeNo.length <= 32);
  assert.notEqual(outTradeNo, result.orderId, "商户单号不得再取订单号，否则重复拉起即 -15012");
});

test("a user's fifth active payment order is rejected while the user lock is held", async () => {
  const pool = createPaymentPool({}, {}, 5);
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.createPayment({ userId: "usr_a", packageId: "ai_generation_30", idempotencyKey: "sixth-order" }),
    (error) => error.code === "MAX_PENDING_ORDERS_REACHED",
  );
  const userLockIndex = pool.calls.findIndex((call) => call.sql.includes("pg_advisory_xact_lock")
    && call.parameters[0] === "pindou-payment-user:usr_a");
  const countIndex = pool.calls.findIndex((call) => call.sql.includes("SELECT COUNT(*)::int AS total"));
  assert.ok(userLockIndex >= 0 && userLockIndex < countIndex, "订单上限统计必须在用户 advisory lock 之后");
  assert.match(pool.calls[countIndex].sql, /status = 'pending'/);
  assert.equal(pool.orderInsert.length, 0);
});

/** 构造「订单已存在且仍是 pending」的假 Pool。 */
test("same-key retry reuses an unpaid attempt and never adds an attempt after WeChat closes it", async () => {
  const signed = [];
  let queryCount = 0;
  const gateway = fakeVirtualGateway({
    createPayment(input) {
      signed.push(input.outTradeNo);
      return {
        signData: JSON.stringify({ outTradeNo: input.outTradeNo, productId: input.productId }),
        paySig: "pay-sig",
        signature: "user-sig",
        mode: "short_series_goods",
      };
    },
    async queryOrder() {
      queryCount += 1;
      return queryCount === 1
        ? { state: "UNPAID", paid: false, mchOrderNo: null, transactionId: null, paidTimeSeconds: null, actualPriceFen: null }
        : { state: "CLOSED", paid: false, mchOrderNo: null, transactionId: null, paidTimeSeconds: null, actualPriceFen: null };
    },
  });
  const pool = existingOrderPool();
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  const input = { userId: "usr_a", packageId: "ai_generation_30", idempotencyKey: "retry-same-intent" };
  const first = await service.createPayment(input);
  await assert.rejects(
    () => service.createPayment(input),
    (error) => error.code === "ORDER_EXPIRED",
  );

  // 第一次仍沿用原商户单号；关闭后拒绝在原购买意图下再签发支付尝试。
  assert.match(first.orderId, /^order_/u);
  assert.equal(signed.length, 1);
  assert.equal(signed[0], "vpay_existingtradeno00001", "状态仍是未支付时应沿用原尝试，避免传输重试创建第二笔");
  assert.equal(pool.attempts.length, 1, "关闭后不在原订单下签发第二个尝试");
  assert.equal(pool.attempts[0].out_trade_no, signed[0]);
  assert.equal(pool.attempts[0].status, "CLOSED");
  assert.equal(pool.updateSql.some((sql) => sql.includes("status = 'closed'")), true);
});

test("same-key retry reports an already-paid order with its order id", async () => {
  const pool = existingOrderPool({ status: "paid" });
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.createPayment({ userId: "usr_a", packageId: "ai_generation_30", idempotencyKey: "retry-paid" }),
    (error) => error.code === "ORDER_ALREADY_PAID" && error.details.orderId === "order_existing",
  );
});

test("same-key retry reports a closed order as expired so the client can start a new purchase", async () => {
  const pool = existingOrderPool({ status: "closed" });
  const service = new PostgresPaymentService(pool, fakeVirtualGateway(), fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.createPayment({ userId: "usr_a", packageId: "ai_generation_30", idempotencyKey: "retry-closed" }),
    (error) => error.code === "ORDER_EXPIRED",
  );
});

test("an expired order confirmed unpaid is closed and requires a new order", async () => {
  const pool = existingOrderPool({ expires_at: new Date(NOW.getTime() - 1_000) });
  const gateway = fakeVirtualGateway({ async queryOrder() { return UNPAID_QUERY; } });
  const service = new PostgresPaymentService(pool, gateway, fakeLegacyGateway(), SECRET, () => NOW);
  await assert.rejects(
    () => service.createPayment({ userId: "usr_a", packageId: "ai_generation_30", idempotencyKey: "retry-same-intent" }),
    (error) => error.code === "ORDER_EXPIRED",
  );
  assert.equal(pool.attempts.length, 1);
  assert.equal(pool.attempts[0].status, "CLOSED");
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

test("new user gate can be switched off for payment integration testing", async () => {
  let eligibilityQueryCount = 0;
  const pool = clientPool((sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    // 断言不是「抛没抛错」，而是「限购查询根本没执行」：只断言错误文案的话，
    // 任何别的分支先抛错都会让用例假绿。
    if (sql.includes("status = 'paid'")) {
      eligibilityQueryCount += 1;
      return { rows: [{ found: 1 }] };
    }
    if (sql.includes("FROM pindou_orders") && !sql.includes("JOIN pindou_users")) return { rows: [] };
    if (sql.includes("FROM pindou_packages")) {
      return { rows: [packageRow({ id: "ai_generation_new_user_5", price_fen: 10, quota_amount: 5 })] };
    }
    // 走到用户查询 = 限购分支确实被跳过了（上面那条用例里这里是「不该到达」）
    if (sql.includes("FROM pindou_users")) throw new Error("GATE_OFF_REACHED_USER_QUERY");
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const service = new PostgresPaymentService(
    pool,
    fakeVirtualGateway(),
    fakeLegacyGateway(),
    SECRET,
    () => NOW,
    undefined,
    false,
  );
  const error = await service
    .createPayment({
      userId: "usr_a",
      packageId: "ai_generation_new_user_5",
      idempotencyKey: "repeat-purchase",
    })
    .then(() => null, (reason) => reason);
  assert.equal(eligibilityQueryCount, 0, "关掉开关后不应再查历史购买记录");
  assert.ok(
    !/仅限首次购买/.test(error?.message ?? ""),
    `关掉开关后不应再报限购，实际：${error?.message}`,
  );
});

/** 构造发货所需的假 Pool：返回一笔 pending 订单。
 *
 * 第二参数 `candidates` 用于补单轮询：给定时，「扫描待发货订单」那条查询会返回它们，
 * 之后的发放链路与发货推送完全共用同一份假实现 —— 两条支路本来就该走同一套幂等逻辑。
 */
