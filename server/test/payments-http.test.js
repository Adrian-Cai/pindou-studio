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
      return {
        orderId: "order_http",
        payment: { timeStamp: "1", nonceStr: "n", package: "prepay_id=wx", signType: "RSA", paySign: "p" },
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
