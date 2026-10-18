const assert = require("node:assert/strict");
const {
  createCipheriv,
  generateKeyPairSync,
  sign,
} = require("node:crypto");
const test = require("node:test");
const { OfficialWeChatPaymentGateway } = require("../dist/modules/payments/wechat-pay-client.js");

const NOW = new Date("2026-08-31T12:00:00.000Z");
const API_V3_KEY = "12345678901234567890123456789012";
const merchantKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platformKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const merchantPrivateKey = merchantKeys.privateKey.export({ type: "pkcs8", format: "pem" });
const platformPublicKey = platformKeys.publicKey.export({ type: "spki", format: "pem" });

function config() {
  return {
    appId: "wx-app",
    merchantId: "mch-123",
    merchantSerialNumber: "merchant-serial",
    merchantPrivateKey,
    apiV3Key: API_V3_KEY,
    platformSerialNumber: "platform-serial",
    platformPublicKey,
    notifyUrl: "https://api.example.test/api/payments/notify",
    timeoutMs: 8000,
    callbackToleranceSeconds: 300,
  };
}

function signedHeaders(rawBody, timestamp = Math.floor(NOW.getTime() / 1000).toString()) {
  const nonce = "callback-signature-nonce";
  return {
    "wechatpay-timestamp": timestamp,
    "wechatpay-nonce": nonce,
    "wechatpay-serial": "platform-serial",
    "wechatpay-signature": sign(
      "RSA-SHA256",
      Buffer.from(`${timestamp}\n${nonce}\n${rawBody}\n`),
      platformKeys.privateKey,
    ).toString("base64"),
  };
}

function notificationBody() {
  const transaction = JSON.stringify({
    mchid: "mch-123",
    appid: "wx-app",
    out_trade_no: "order_test",
    transaction_id: "wx_transaction_1",
    trade_state: "SUCCESS",
    success_time: "2026-08-31T20:00:00+08:00",
    amount: { total: 990, currency: "CNY" },
    payer: { openid: "payer-openid-private" },
  });
  const nonce = "0123456789ab";
  const associatedData = "transaction";
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(API_V3_KEY), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([cipher.update(transaction), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({
    id: "notice-1",
    event_type: "TRANSACTION.SUCCESS",
    resource: {
      algorithm: "AEAD_AES_256_GCM",
      nonce,
      associated_data: associatedData,
      ciphertext: encrypted.toString("base64"),
    },
  });
}

test("official callback verifier validates raw signature, freshness, and AES-GCM resource", () => {
  const client = new OfficialWeChatPaymentGateway(config(), undefined, () => NOW);
  const rawBody = notificationBody();
  assert.deepEqual(client.verifyNotification({ rawBody, headers: signedHeaders(rawBody) }), {
    eventType: "TRANSACTION.SUCCESS",
    merchantId: "mch-123",
    appId: "wx-app",
    orderId: "order_test",
    transactionId: "wx_transaction_1",
    tradeState: "SUCCESS",
    amountFen: 990,
    currency: "CNY",
    payerOpenid: "payer-openid-private",
    paidAt: NOW,
  });

  assert.throws(
    () => client.verifyNotification({ rawBody: `${rawBody} `, headers: signedHeaders(rawBody) }),
    (error) => error.code === "PAYMENT_NOTIFY_SIGNATURE_INVALID",
  );
  const expired = (Math.floor(NOW.getTime() / 1000) - 301).toString();
  assert.throws(
    () => client.verifyNotification({ rawBody, headers: signedHeaders(rawBody, expired) }),
    (error) => error.code === "PAYMENT_NOTIFY_SIGNATURE_INVALID",
  );
});

// 生产下单链路当前改走虚拟支付；此用例只守护旧商户号网关的适配器实现。
test("official JSAPI order adapter verifies WeChat response and returns only client-safe payment fields", async () => {
  let capturedRequest;
  const fetchImplementation = async (url, init) => {
    capturedRequest = { url, init };
    const body = JSON.stringify({ prepay_id: "wx_prepay_test" });
    return new Response(body, {
      status: 200,
      headers: signedHeaders(body),
    });
  };
  const client = new OfficialWeChatPaymentGateway(config(), fetchImplementation, () => NOW);
  const result = await client.createPayment({
    orderId: "order_test",
    description: "拼豆工作室-AI 精致生成 30 次",
    amountFen: 990,
    currency: "CNY",
    payerOpenid: "payer-openid-private",
  });
  assert.equal(capturedRequest.url, "https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi");
  const requestBody = JSON.parse(capturedRequest.init.body);
  assert.equal(requestBody.amount.total, 990);
  assert.equal(requestBody.payer.openid, "payer-openid-private");
  assert.match(capturedRequest.init.headers.authorization, /^WECHATPAY2-SHA256-RSA2048 /);
  assert.deepEqual(Object.keys(result.payment).sort(), ["nonceStr", "package", "paySign", "signType", "timeStamp"].sort());
  assert.equal(JSON.stringify(result).includes(API_V3_KEY), false);
  assert.equal(JSON.stringify(result).includes("PRIVATE KEY"), false);
});
