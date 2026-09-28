const assert = require("node:assert/strict");
const test = require("node:test");
const { AppError } = require("../dist/shared/app-error.js");
const { createHttpApplication } = require("../dist/http/app.js");
const { startHttpServer } = require("../dist/http/server.js");

async function withServer(payments, run) {
  let authenticationCount = 0;
  const unused = new Proxy({}, { get() { return async () => { throw new Error("unexpected dependency call"); }; } });
  const running = await startHttpServer(createHttpApplication({
    database: { async check() { return { status: "up" }; } },
    auth: unused,
    authenticator: {
      async authenticate(value) {
        authenticationCount += 1;
        if (value !== "Bearer valid-payment-token-1234567890") {
          throw new AppError(401, "UNAUTHORIZED", "请先登录");
        }
        return { id: "usr_payment" };
      },
    },
    users: unused,
    avatars: unused,
    avatarMaximumBytes: 1024,
    files: unused,
    covers: unused,
    works: unused,
    quotaDownloads: unused,
    payments,
    coverMaximumBytes: 1024,
  }), "127.0.0.1", 0);
  try {
    await run(`http://127.0.0.1:${running.port}`, () => authenticationCount);
  } finally {
    await running.close();
  }
}

test("packages is public and payment creation accepts only packageId from an authenticated user", async () => {
  const createCalls = [];
  const payments = {
    async listPackages() {
      return { items: [{ id: "ai_generation_30", label: "AI 精致生成 30 次", quotaAmount: 30, quotaKind: "ai_generation", membershipType: null, priceFen: 990, currency: "CNY", enabled: true }] };
    },
    async createPayment(input) {
      createCalls.push(input);
      if (input.idempotencyKey === "payment-http-paid") {
        throw new AppError(409, "ORDER_ALREADY_PAID", "订单已支付", { orderId: "order_0123456789abcdef0123456789" });
      }
      return {
        orderId: "order_http",
        virtual: { signData: "{}", paySig: "p", signature: "s", mode: "short_series_goods" },
        payment: null,
      };
    },
    async handleNotification() { throw new Error("unused"); },
  };
  await withServer(payments, async (baseUrl, authenticationCount) => {
    const packages = await fetch(`${baseUrl}/api/packages`);
    assert.equal(packages.status, 200);
    assert.equal((await packages.json()).items[0].priceFen, 990);
    assert.equal(authenticationCount(), 0);

    const tampered = await fetch(`${baseUrl}/api/payments/create`, {
      method: "POST",
      headers: {
        authorization: "Bearer valid-payment-token-1234567890",
        "content-type": "application/json",
        "idempotency-key": "payment-http-1",
      },
      body: JSON.stringify({ packageId: "ai_generation_30", priceFen: 1 }),
    });
    assert.equal(tampered.status, 400);
    assert.equal((await tampered.json()).error.code, "INVALID_ARGUMENT");
    assert.equal(createCalls.length, 0);

    const created = await fetch(`${baseUrl}/api/payments/create`, {
      method: "POST",
      headers: {
        authorization: "Bearer valid-payment-token-1234567890",
        "content-type": "application/json",
        "idempotency-key": "payment-http-2",
      },
      body: JSON.stringify({ packageId: "ai_generation_30" }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).orderId, "order_http");
    assert.deepEqual(createCalls, [{ userId: "usr_payment", packageId: "ai_generation_30", idempotencyKey: "payment-http-2" }]);

    const alreadyPaid = await fetch(`${baseUrl}/api/payments/create`, {
      method: "POST",
      headers: {
        authorization: "Bearer valid-payment-token-1234567890",
        "content-type": "application/json",
        "idempotency-key": "payment-http-paid",
      },
      body: JSON.stringify({ packageId: "ai_generation_30" }),
    });
    assert.equal(alreadyPaid.status, 409);
    assert.deepEqual((await alreadyPaid.json()).error.details, { orderId: "order_0123456789abcdef0123456789" });
  });
});

test("payment order continue and cancel require auth, forward the order id, and reject query params", async () => {
  const calls = [];
  const payments = {
    async listPackages() { return { items: [] }; },
    async createPayment() { throw new Error("unused"); },
    async continuePayment(input) {
      calls.push({ action: "continue", ...input });
      return {
        orderId: input.orderId,
        virtual: { signData: "{}", paySig: "p", signature: "s", mode: "short_series_goods" },
        payment: null,
      };
    },
    async cancelOrder(input) {
      calls.push({ action: "cancel", ...input });
      return { status: "closed" };
    },
    async handleNotification() { throw new Error("unused"); },
  };
  await withServer(payments, async (baseUrl) => {
    const auth = { authorization: "Bearer valid-payment-token-1234567890" };

    const continued = await fetch(`${baseUrl}/api/payments/order_abc123/continue`, { method: "POST", headers: auth });
    assert.equal(continued.status, 200);
    assert.equal((await continued.json()).orderId, "order_abc123");

    const cancelled = await fetch(`${baseUrl}/api/payments/order_abc123/cancel`, { method: "POST", headers: auth });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), { status: "closed" });
    assert.deepEqual(calls, [
      { action: "continue", userId: "usr_payment", orderId: "order_abc123" },
      { action: "cancel", userId: "usr_payment", orderId: "order_abc123" },
    ]);

    const anonymous = await fetch(`${baseUrl}/api/payments/order_abc123/cancel`, { method: "POST" });
    assert.equal(anonymous.status, 401);

    const withQuery = await fetch(`${baseUrl}/api/payments/order_abc123/continue?force=1`, { method: "POST", headers: auth });
    assert.equal(withQuery.status, 400);

    const wrongMethod = await fetch(`${baseUrl}/api/payments/order_abc123/continue`, { headers: auth });
    assert.equal(wrongMethod.status, 404, "只开放 POST，GET 落到通用 404");
  });
});

test("WeChat notification bypasses Bearer auth, preserves raw body, and returns WeChat acknowledgements", async () => {
  const notifications = [];
  const payments = {
    async listPackages() { return { items: [] }; },
    async createPayment() { throw new Error("unused"); },
    async handleNotification(input) {
      notifications.push(input);
      if (input.headers["wechatpay-signature"] !== "valid-signature") {
        throw new AppError(401, "PAYMENT_NOTIFY_SIGNATURE_INVALID", "微信支付签名校验失败");
      }
      return { duplicate: false };
    },
  };
  await withServer(payments, async (baseUrl, authenticationCount) => {
    const rawBody = '{"id":"notice-1", "resource":{}}';
    const failed = await fetch(`${baseUrl}/api/payments/notify`, {
      method: "POST",
      headers: { "content-type": "application/json", "wechatpay-signature": "bad" },
      body: rawBody,
    });
    assert.equal(failed.status, 401);
    assert.deepEqual(await failed.json(), { code: "FAIL", message: "微信支付签名校验失败" });

    const succeeded = await fetch(`${baseUrl}/api/payments/notify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "wechatpay-timestamp": "1788177600",
        "wechatpay-nonce": "nonce",
        "wechatpay-serial": "serial",
        "wechatpay-signature": "valid-signature",
      },
      body: rawBody,
    });
    assert.equal(succeeded.status, 200);
    assert.deepEqual(await succeeded.json(), { code: "SUCCESS", message: "成功" });
    assert.equal(authenticationCount(), 0);
    assert.equal(notifications[1].rawBody, rawBody);
    assert.equal(notifications[1].headers["wechatpay-serial"], "serial");
  });
});
