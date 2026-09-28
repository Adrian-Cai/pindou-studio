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
        signData: JSON.stringify({ outTradeNo: input.outTradeNo, productId: input.productId }),
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
function createPaymentPool(packageOverrides = {}, userOverrides = {}, pendingTotal = 0) {
  const orderInsert = [];
  const attemptInsert = [];
  const pool = clientPool((sql, parameters) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("SELECT EXISTS")) return { rows: [{ found: false }] };
    if (sql.includes("SELECT COUNT(*)::int AS total")) return { rows: [{ total: pendingTotal }] };
    if (sql.includes("FROM pindou_orders")) return { rows: [] };
    if (sql.includes("FROM pindou_packages")) return { rows: [packageRow(packageOverrides)] };
    if (sql.includes("FROM pindou_users") && sql.includes("SELECT openid_ciphertext, session")) {
      return { rows: [{
        openid_ciphertext: ENCRYPTED_OPENID,
        session_key_ciphertext: userOverrides.sessionKeyCiphertext === undefined ? ENCRYPTED_SESSION_KEY : userOverrides.sessionKeyCiphertext,
      }] };
    }
    if (sql.includes("INSERT INTO pindou_orders")) { pool.orderInsert.push(parameters); return { rows: [] }; }
    if (sql.includes("INSERT INTO pindou_payment_attempts")) { pool.attemptInsert.push(parameters); return { rows: [] }; }
    if (sql.includes("UPDATE pindou_orders")) return { rows: [] };
    if (sql.includes("SELECT session_key_ciphertext")) {
      return { rows: [{ session_key_ciphertext: userOverrides.sessionKeyCiphertext === undefined ? ENCRYPTED_SESSION_KEY : userOverrides.sessionKeyCiphertext }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  pool.orderInsert = orderInsert;
  pool.attemptInsert = attemptInsert;
  return pool;
}

function existingOrderPool(orderOverrides = {}) {
  const updates = [];
  const updateSql = [];
  const attempts = [{
    id: "pa_existing",
    order_id: "order_existing",
    user_id: "usr_a",
    out_trade_no: "vpay_existingtradeno00001",
    status: "ISSUED",
    wechat_transaction_id: null,
    amount_fen: 990,
    created_at: new Date(NOW.getTime() - 60_000),
    paid_at: null,
    closed_at: null,
  }];
  const orderRow = {
    id: "order_existing",
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
    virtual_out_trade_no: "vpay_existingtradeno00001",
    created_at: new Date(NOW.getTime() - 60_000),
    expires_at: new Date(NOW.getTime() + 4 * 60_000),
    // 继续支付/取消查到微信已付时会走 confirmAndGrant，它需要可解密的付款人身份
    openid_ciphertext: ENCRYPTED_OPENID,
    ...orderOverrides,
  };
  const pool = clientPool((sql, parameters) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("SELECT EXISTS")) return { rows: [{ found: false }] };
    if (sql.includes("SELECT COUNT(*)::int AS total")) return { rows: [{ total: 0 }] };
    if (sql.includes("FROM pindou_orders") && sql.includes("FOR UPDATE")) return { rows: [orderRow] };
    if (sql.includes("FROM pindou_packages")) return { rows: [packageRow()] };
    if (sql.includes("FROM pindou_payment_attempts")) return { rows: [attempts.at(-1)] };
    if (sql.includes("FROM pindou_users") && sql.includes("SELECT openid_ciphertext, session")) {
      return { rows: [{ openid_ciphertext: ENCRYPTED_OPENID, session_key_ciphertext: ENCRYPTED_SESSION_KEY }] };
    }
    // 取消订单链路只取 openid（无需 session_key 签名）
    if (sql.includes("FROM pindou_users") && sql.includes("SELECT openid_ciphertext")) {
      return { rows: [{ openid_ciphertext: ENCRYPTED_OPENID }] };
    }
    if (sql.includes("UPDATE pindou_orders")) {
      pool.updates.push(parameters);
      pool.updateSql.push(sql);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE pindou_payment_attempts")) {
      const attempt = attempts.find((item) => item.id === parameters[0]);
      if (attempt) attempt.status = parameters[1];
      return { rows: [], rowCount: attempt ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO pindou_payment_attempts")) {
      attempts.push({
        id: parameters[0], order_id: parameters[1], user_id: parameters[2], out_trade_no: parameters[3],
        status: "ISSUED", amount_fen: parameters[4], created_at: parameters[5], paid_at: null,
        closed_at: null, wechat_transaction_id: null,
      });
      return { rows: [] };
    }
    // 命中既有订单就意味着重复建单：此时再 INSERT 会撞主键，属于实现错误
    if (sql.includes("INSERT INTO pindou_orders")) throw new Error("命中既有订单时不应再 INSERT");
    if (sql.includes("INSERT INTO pindou_quota_transactions")) {
      pool.quotaInserts.push(parameters);
      return { rows: [{ id: "qt_grant_existing" }] };
    }
    if (sql.includes("FROM pindou_quota_transactions")) return { rows: [] };
    if (sql.includes("SELECT status FROM pindou_orders")) return { rows: [{ status: orderRow.status }] };
    if (sql.includes("SELECT session_key_ciphertext")) {
      return { rows: [{ session_key_ciphertext: ENCRYPTED_SESSION_KEY }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  pool.updates = updates;
  pool.updateSql = updateSql;
  pool.attempts = attempts;
  pool.quotaInserts = [];
  return pool;
}

function deliveryPool(orderOverrides = {}, candidates = null) {
  const updates = [];
  const updateSql = [];
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
    virtual_out_trade_no: "vpay_existingtradeno00001",
    expires_at: new Date(NOW.getTime() - 60_000),
    openid_ciphertext: ENCRYPTED_OPENID,
    ...orderOverrides,
  };
  const attempt = {
    id: "pa_test",
    order_id: orderRow.id,
    user_id: orderRow.user_id,
    out_trade_no: orderRow.virtual_out_trade_no,
    status: "ISSUED",
    wechat_transaction_id: null,
    amount_fen: orderRow.price_fen,
    created_at: NOW,
    paid_at: null,
    closed_at: null,
  };
  const events = new Map();
  const pool = clientPool((sql, parameters) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    if (sql.includes("INSERT INTO pindou_payment_events")) {
      const fingerprint = parameters[2];
      if (events.has(fingerprint)) return { rows: [] };
      const event = { id: parameters[0], order_id: parameters[3], attempt_id: parameters[4], status: "RECEIVED" };
      events.set(fingerprint, event);
      return { rows: [event] };
    }
    if (sql.includes("FROM pindou_payment_events")) {
      const event = [...events.entries()].find(([fingerprint]) => fingerprint === parameters[0])?.[1];
      return { rows: event ? [event] : [] };
    }
    if (sql.includes("UPDATE pindou_payment_events")) {
      const event = [...events.values()].find((item) => item.id === parameters[0]);
      if (event) event.status = parameters[1];
      return { rows: [], rowCount: event ? 1 : 0 };
    }
    if (sql.includes("SELECT id, order_id FROM pindou_payment_attempts")) {
      return { rows: parameters[0] === attempt.out_trade_no ? [{ id: attempt.id, order_id: attempt.order_id }] : [] };
    }
    if (sql.includes("COUNT(*)::int AS total FROM pindou_payment_attempts")) {
      return { rows: [{ total: attempt.status === "CLOSED" ? 0 : 1 }] };
    }
    if (sql.includes("FROM pindou_payment_attempts") && sql.includes("WHERE id = $1 AND order_id = $2")) {
      const candidate = candidates?.find((item) => item.attempt_id === parameters[0]);
      if (candidate) return { rows: [{ ...attempt, id: candidate.attempt_id, order_id: candidate.id, out_trade_no: candidate.out_trade_no }] };
      return { rows: parameters[0] === attempt.id ? [attempt] : [] };
    }
    if (candidates !== null && sql.includes("attempts.id AS attempt_id")) return { rows: candidates };
    if (sql.includes("UPDATE pindou_payment_attempts")) {
      if (sql.includes("SET status = 'SUCCEEDED'")) {
        attempt.status = "SUCCEEDED";
        attempt.wechat_transaction_id = parameters[1];
      } else {
        if (candidates) {
          const candidate = candidates.find((item) => item.attempt_id === parameters[0]);
          if (candidate) candidate.status = parameters[1];
        }
        attempt.status = parameters[1];
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE pindou_orders orders")) return { rows: [], rowCount: 0 };
    // 商户单号 → 订单号的回查：要么命中 virtual_out_trade_no，要么本身就是订单号，
    // 两者都对不上才算查不到 —— 与真实 SQL 的语义保持一致
    if (sql.includes("virtual_out_trade_no = $1 OR id = $1")) {
      const hit = orderRow.virtual_out_trade_no === parameters[0] || orderRow.id === parameters[0];
      return { rows: hit ? [{ id: orderRow.id }] : [] };
    }
    if (sql.includes("FROM pindou_orders") && sql.includes("status = 'pending'") && sql.includes("FOR UPDATE")) {
      return { rows: orderRow.status === "pending" && orderRow.expires_at <= parameters[1] ? [{ id: orderRow.id }] : [] };
    }
    if (sql.includes("FOR UPDATE OF orders")) return { rows: parameters[0] === orderRow.id ? [orderRow] : [] };
    if (sql.includes("UPDATE pindou_orders")) {
      pool.updates.push(parameters);
      pool.updateSql.push(sql);
      // 关单与置为 paid 是两种结局，假 Pool 必须分别反映，否则「关单后不再发放」
      // 这类断言测不到真实的状态流转。rowCount 也要给：关单靠它判断有没有真的改到行。
      if (sql.includes("status = 'closed'")) {
        orderRow.status = "closed";
        return { rows: [], rowCount: 1 };
      }
      // 让假 Pool 具备真实语义：订单一旦置为 paid，后续读取必须看到 paid，
      // 否则「重复发货应被识别为 duplicate」这条断言永远测不到真实行为。
      orderRow.status = "paid";
      orderRow.wx_transaction_id = parameters[1];
      return { rows: [], rowCount: 1 };
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
  pool.updateSql = updateSql;
  pool.inserts = inserts;
  pool.attempt = attempt;
  pool.orderRow = orderRow;
  return pool;
}

function deliveryInput(overrides = {}) {
  return {
    openId: OPENID,
    outTradeNo: "vpay_existingtradeno00001",
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

const RECONCILE_OPTIONS = {
  graceMs: 3 * 60_000,
  staleAfterMs: 30 * 60_000,
  closeAfterMs: 60 * 60_000,
  batchSize: 10,
};

/** 构造一个比 NOW 早 ageMs 的待补单候选行。 */
function candidateRow(id, ageMs, overrides = {}) {
  return {
    id,
    created_at: new Date(NOW.getTime() - ageMs),
    expires_at: new Date(NOW.getTime() - ageMs + 5 * 60_000),
    attempt_id: `pa_${id}`,
    openid_ciphertext: ENCRYPTED_OPENID,
    out_trade_no: `vpay_${id}`,
    ...overrides,
  };
}

/** 未付款的查单结果。 */
const UNPAID_QUERY = {
  state: "UNPAID",
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

function refundPool(options = {}) {
  const updates = [];
  const inserts = [];
  const orderRow = {
    id: "order_test",
    user_id: "usr_a",
    package_id: "ai_generation_30",
    price_fen: 990,
    package_label_snapshot: "AI 精致生成 30 次",
    quota_amount_snapshot: 30,
    quota_kind_snapshot: "ai_generation",
    status: "paid",
    paid_at: NOW,
    virtual_out_trade_no: "vpay_refundtradeno0001",
    openid_ciphertext: ENCRYPTED_OPENID,
    ...options.order,
  };
  const purchasedRemaining = options.purchasedRemaining ?? 30;
  const attempt = {
    id: "pa_refund", order_id: orderRow.id, user_id: orderRow.user_id,
    out_trade_no: orderRow.virtual_out_trade_no, status: "SUCCEEDED",
    wechat_transaction_id: "transaction_1", amount_fen: 990, created_at: NOW,
    paid_at: NOW, closed_at: null, order_status: orderRow.status,
  };
  const events = new Map();
  const pool = clientPool((sql, parameters) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("INSERT INTO pindou_payment_events")) {
      const fingerprint = parameters[2];
      if (events.has(fingerprint)) return { rows: [] };
      const event = { id: parameters[0], order_id: parameters[3], attempt_id: parameters[4], status: "RECEIVED" };
      events.set(fingerprint, event);
      return { rows: [event] };
    }
    if (sql.includes("FROM pindou_payment_events")) {
      const event = [...events.entries()].find(([fingerprint]) => fingerprint === parameters[0])?.[1];
      return { rows: event ? [event] : [] };
    }
    if (sql.includes("UPDATE pindou_payment_events")) {
      const event = [...events.values()].find((item) => item.id === parameters[0]);
      if (event) event.status = parameters[1];
      return { rows: [], rowCount: event ? 1 : 0 };
    }
    if (sql.includes("SELECT id, order_id FROM pindou_payment_attempts")) {
      return { rows: parameters[0] === attempt.out_trade_no ? [{ id: attempt.id, order_id: attempt.order_id }] : [] };
    }
    if (sql.includes("FROM pindou_payment_attempts attempts")) {
      const matches = parameters[0] === attempt.out_trade_no
        || (parameters[1] === attempt.order_id && attempt.status === "SUCCEEDED");
      return { rows: matches ? [{ ...attempt, order_status: orderRow.status }] : [] };
    }
    if (sql.includes("FROM pindou_payment_attempts") && sql.includes("WHERE id = $1 AND order_id = $2")) {
      return { rows: parameters[0] === attempt.id ? [attempt] : [] };
    }
    if (sql.includes("UPDATE pindou_payment_attempts")) {
      if (sql.includes("SET status = 'SUCCEEDED'")) {
        attempt.status = "SUCCEEDED";
        attempt.wechat_transaction_id = parameters[1];
      } else {
        attempt.status = parameters[1];
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("virtual_out_trade_no = $1 OR id = $1")) {
      const hit = orderRow.virtual_out_trade_no === parameters[0] || orderRow.id === parameters[0];
      // iOS 退款问询只查这一句且要的是完整订单行，其余是「商户单号 → 订单号」的回查
      return { rows: hit ? (sql.includes("user_id") ? [orderRow] : [{ id: orderRow.id }]) : [] };
    }
    // lockQuotaUser：SELECT id FROM pindou_users ... FOR UPDATE
    if (sql.includes("FOR UPDATE") && sql.includes("FROM pindou_users")) return { rows: [{ id: "usr_a" }] };
    // readQuota 的聚合查询
    if (sql.includes("SUM(amount) FILTER")) {
      return {
        rows: [{
          daily_free: "0",
          used_today: "0",
          daily_remaining: "0",
          purchased: String(purchasedRemaining),
        }],
      };
    }
    if (sql.includes("FOR UPDATE OF orders")) return { rows: options.missingOrder ? [] : [orderRow] };
    if (sql.includes("FROM pindou_orders") && sql.includes("LIMIT 1")) {
      return { rows: options.missingOrder ? [] : [orderRow] };
    }
    if (sql.includes("UPDATE pindou_orders")) {
      pool.updates.push(parameters);
      orderRow.status = sql.includes("status = 'refunded'") ? "refunded" : "paid";
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO pindou_quota_transactions")) {
      pool.inserts.push(parameters);
      return { rows: [{ id: "qt_refund_1" }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  pool.updates = updates;
  pool.inserts = inserts;
  pool.attempt = attempt;
  pool.orderRow = orderRow;
  return pool;
}

function refundInput(overrides = {}) {
  return {
    openId: OPENID,
    mchOrderId: "order_test",
    attach: "order_test",
    wxRefundId: "wx_refund_1",
    refundFeeFen: 990,
    retCode: 0,
    retMsg: null,
    refundSuccTimestamp: Math.floor(NOW.getTime() / 1000),
    ...overrides,
  };
}

function refundService(pool) {
  return reconcileService(pool, fakeVirtualGateway({
    async queryOrder() {
      return {
        state: "REFUNDED",
        paid: false,
        mchOrderNo: "mch_order_1",
        transactionId: "transaction_1",
        paidTimeSeconds: Math.floor(NOW.getTime() / 1000),
        actualPriceFen: 990,
      };
    },
  }));
}

/**
 * 退款扣回的核心不变式：**只扣还没消耗的部分**。
 *
 * 用户买 30 次、已经用掉 22 次，能收回的只有剩的 8 次。
 * 硬扣 30 会把 purchased 打成 -22，而额度读取把负数钳成 0 ——
 * 表面上余额归零看着正常，用户下次再买时新额度会被这个负余额悄悄吃掉。
 */

module.exports = { assert, test, PostgresPaymentService, NOW, SECRET, OPENID, SESSION_KEY, ENCRYPTED_OPENID, ENCRYPTED_SESSION_KEY, clientPool, packageRow, fakeVirtualGateway, fakeLegacyGateway, createPaymentPool, existingOrderPool, deliveryPool, deliveryInput, RECONCILE_OPTIONS, candidateRow, UNPAID_QUERY, captureConsole, reconcileService, refundPool, refundInput, refundService };
