const assert = require("node:assert/strict");
const test = require("node:test");
const { createCipheriv, createHash, randomBytes } = require("node:crypto");
const { AppError } = require("../dist/shared/app-error.js");
const { createHttpApplication } = require("../dist/http/app.js");
const { startHttpServer } = require("../dist/http/server.js");
const {
  decryptPushBody,
  extractPushCiphertext,
  verifyPushMessageSignature,
  verifyPushRequest,
  verifyPushSignature,
} = require("../dist/modules/payments/virtual-pay-push.js");

const APP_ID = "wxappid0000000001";
const TOKEN = "pindou_push_token";

/** 生成一把真实可用的 EncodingAESKey：32 字节密钥的 base64 去掉末尾的 "=" 正好 43 字符。 */
function makeEncodingAesKey() {
  return randomBytes(32).toString("base64").slice(0, 43);
}

const ENCODING_AES_KEY = makeEncodingAesKey();

function sha1Hex(parts) {
  return createHash("sha1").update([...parts].sort().join(""), "utf8").digest("hex");
}

/** 按微信的明文布局组包：random(16B) + msg_len(4B 大端) + msg + appid。 */
function encryptPushMessage(message, encodingAesKey, appId) {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  const body = Buffer.from(message, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const payload = Buffer.concat([randomBytes(16), length, body, Buffer.from(appId, "utf8")]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  return Buffer.concat([cipher.update(payload), cipher.final()]).toString("base64");
}

const DELIVERY_JSON = JSON.stringify({
  Event: "xpay_goods_deliver_notify",
  OpenId: "op_push_user",
  OutTradeNo: "order_push_1",
  Env: 0,
  WeChatPayInfo: { MchOrderNo: "mch_push_1", TransactionId: "tx_push_1", PaidTime: 1_700_000_000 },
  GoodsInfo: { ProductId: "ai_generation_30", Quantity: 1, ActualPrice: 990, Attach: "order_push_1" },
});

const IOS_QUERY_JSON = JSON.stringify({
  Event: "xpay_subscribe_ios_refund_query_notify",
  OpenId: "op_push_user",
  pay_order_id: "order_push_2",
  provide_status: 1,
  channel_bill: "bill_push_2",
});

function deliveryDouble(calls) {
  return {
    async handleDelivery(input) { calls.push(["delivery", input]); },
    async handleRefund(input) { calls.push(["refund", input]); },
    async answerIosRefundQuery(input) {
      calls.push(["ios", input]);
      return { resultCode: 1, resultInfo: "已发货", evidence: "tx_push_2" };
    },
    async listPackages() { throw new Error("unused"); },
    async listOrders() { throw new Error("unused"); },
    async createPayment() { throw new Error("unused"); },
  };
}

async function withServer(payments, virtualPayPush, run) {
  const unused = new Proxy({}, { get() { return async () => { throw new Error("unexpected dependency call"); }; } });
  const running = await startHttpServer(createHttpApplication({
    database: { async check() { return { status: "up" }; } },
    auth: unused,
    authenticator: unused,
    users: unused,
    avatars: unused,
    avatarMaximumBytes: 1024,
    files: unused,
    covers: unused,
    works: unused,
    quotaDownloads: unused,
    payments,
    coverMaximumBytes: 1024,
    virtualPayPush,
  }), "127.0.0.1", 0);
  try {
    await run(`http://127.0.0.1:${running.port}`);
  } finally {
    await running.close();
  }
}

test("verifyPushSignature 按 token/timestamp/nonce 字典序拼接校验", () => {
  const timestamp = "1700000000";
  const nonce = "nonce12345";
  assert.equal(verifyPushSignature(TOKEN, {
    signature: sha1Hex([TOKEN, timestamp, nonce]),
    timestamp,
    nonce,
  }), true);
  assert.equal(verifyPushSignature(TOKEN, { signature: "deadbeef", timestamp, nonce }), false);
  assert.equal(verifyPushSignature(TOKEN, { signature: sha1Hex([TOKEN, timestamp, nonce]) }), false);
  assert.equal(verifyPushSignature("", { signature: sha1Hex([TOKEN, timestamp, nonce]), timestamp, nonce }), false);
});

test("verifyPushMessageSignature 把密文纳入签名，换一封密文就验不过", () => {
  const timestamp = "1700000000";
  const nonce = "nonce12345";
  const ciphertext = encryptPushMessage(DELIVERY_JSON, ENCODING_AES_KEY, APP_ID);
  const signature = sha1Hex([TOKEN, timestamp, nonce, ciphertext]);
  assert.equal(verifyPushMessageSignature(TOKEN, { msgSignature: signature, timestamp, nonce }, ciphertext), true);
  assert.equal(
    verifyPushMessageSignature(TOKEN, { msgSignature: signature, timestamp, nonce }, `${ciphertext}x`),
    false,
  );
});

test("verifyPushRequest 必须验签；安全模式签名必须覆盖密文", () => {
  const timestamp = "1700000000";
  const nonce = "nonce12345";
  const ciphertext = encryptPushMessage(DELIVERY_JSON, ENCODING_AES_KEY, APP_ID);
  const credentials = { token: TOKEN, encodingAesKey: ENCODING_AES_KEY, appId: APP_ID };

  assert.equal(verifyPushRequest(credentials, { msgSignature: sha1Hex([TOKEN, timestamp, nonce, ciphertext]), timestamp, nonce }, ciphertext), true);
  // 安全模式不能用未覆盖密文的普通 signature 降级通过
  assert.equal(verifyPushRequest(credentials, { signature: sha1Hex([TOKEN, timestamp, nonce]), timestamp, nonce }, ciphertext), false);
  // 没有签名参数 —— 无法确认来源，必须拒绝
  assert.equal(verifyPushRequest(credentials, { timestamp, nonce }, ciphertext), false);
  // 明文模式必须有有效签名
  assert.equal(verifyPushRequest(credentials, { signature: "wrong", timestamp, nonce }, null), false);
  assert.equal(verifyPushRequest(credentials, { timestamp, nonce }, null), false);
  assert.equal(verifyPushRequest(credentials, { signature: sha1Hex([TOKEN, timestamp, nonce]), timestamp, nonce }, null), true);
  // 未配置 token 时不能确认来源，一律拒绝
  assert.equal(verifyPushRequest({ ...credentials, token: "" }, { signature: sha1Hex([TOKEN, timestamp, nonce]), timestamp, nonce }, null), false);
});

test("extractPushCiphertext 同时认 XML 与 JSON 两种包装", () => {
  const ciphertext = encryptPushMessage(DELIVERY_JSON, ENCODING_AES_KEY, APP_ID);
  assert.equal(extractPushCiphertext(JSON.stringify({ Encrypt: ciphertext })), ciphertext);
  assert.equal(extractPushCiphertext(`<xml><Encrypt><![CDATA[${ciphertext}]]></Encrypt></xml>`), ciphertext);
  assert.equal(extractPushCiphertext(DELIVERY_JSON), null);
  assert.equal(extractPushCiphertext(""), null);
});

test("decryptPushBody 解出明文并核对 AppId", () => {
  const jsonWrapped = JSON.stringify({ Encrypt: encryptPushMessage(DELIVERY_JSON, ENCODING_AES_KEY, APP_ID) });
  assert.equal(decryptPushBody(extractPushCiphertext(jsonWrapped), ENCODING_AES_KEY, APP_ID), DELIVERY_JSON);

  const xmlWrapped = `<xml><Encrypt><![CDATA[${encryptPushMessage(DELIVERY_JSON, ENCODING_AES_KEY, APP_ID)}]]></Encrypt></xml>`;
  assert.equal(decryptPushBody(extractPushCiphertext(xmlWrapped), ENCODING_AES_KEY, APP_ID), DELIVERY_JSON);

  // 别的小程序投过来的消息：解密能成功，但 AppId 对不上就必须拒绝
  const foreign = encryptPushMessage(DELIVERY_JSON, ENCODING_AES_KEY, "wxsomeoneelse");
  assert.throws(
    () => decryptPushBody(foreign, ENCODING_AES_KEY, APP_ID),
    (error) => error instanceof AppError && error.code === "VIRTUAL_PAY_PUSH_APP_ID_MISMATCH",
  );

  assert.throws(
    () => decryptPushBody(foreign, "tooshort", APP_ID),
    (error) => error instanceof AppError && error.code === "VIRTUAL_PAY_PUSH_KEY_INVALID",
  );
});

test("GET 握手：Token 未配置报 503，签名错报 403，成对则原样回显 echostr", async () => {
  const timestamp = "1700000000";
  const nonce = "nonce12345";
  const calls = [];
  const credentials = { token: TOKEN, encodingAesKey: "", appId: APP_ID };

  await withServer(deliveryDouble(calls), undefined, async (baseUrl) => {
    const unconfigured = await fetch(`${baseUrl}/api/payments/virtual-notify?signature=x&timestamp=${timestamp}&nonce=${nonce}&echostr=hello`);
    assert.equal(unconfigured.status, 503);
    assert.equal((await unconfigured.json()).error.code, "VIRTUAL_PAY_PUSH_NOT_CONFIGURED");
  });

  await withServer(deliveryDouble(calls), credentials, async (baseUrl) => {
    const wrong = await fetch(`${baseUrl}/api/payments/virtual-notify?signature=deadbeef&timestamp=${timestamp}&nonce=${nonce}&echostr=hello`);
    assert.equal(wrong.status, 403);
    assert.equal((await wrong.json()).error.code, "INVALID_CALLBACK_SIGNATURE");

    const signature = sha1Hex([TOKEN, timestamp, nonce]);
    const ok = await fetch(`${baseUrl}/api/payments/virtual-notify?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=Mzi3wDcVa5uI`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "Mzi3wDcVa5uI");
  });
});

test("POST 明文推送带签名参数不再被拒，且能正常发货", async () => {
  const timestamp = "1700000000";
  const nonce = "nonce12345";
  const signature = sha1Hex([TOKEN, timestamp, nonce]);
  const calls = [];
  await withServer(deliveryDouble(calls), { token: TOKEN, encodingAesKey: "", appId: APP_ID }, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/payments/virtual-notify?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
      { method: "POST", body: DELIVERY_JSON },
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<ErrCode>0<\/ErrCode>/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "delivery");
    assert.equal(calls[0][1].outTradeNo, "order_push_1");
  });
});

test("POST 签名错回 ErrCode=1 且不发货", async () => {
  const calls = [];
  await withServer(deliveryDouble(calls), { token: TOKEN, encodingAesKey: "", appId: APP_ID }, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/payments/virtual-notify?signature=deadbeef&timestamp=1700000000&nonce=nonce12345`,
      { method: "POST", body: DELIVERY_JSON },
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<ErrCode>1<\/ErrCode>/);
    assert.equal(calls.length, 0);
  });
});

test("POST 安全模式：解密后按 Event 分发，iOS 问询也能正常应答", async () => {
  const timestamp = "1700000000";
  const nonce = "nonce12345";
  const credentials = { token: TOKEN, encodingAesKey: ENCODING_AES_KEY, appId: APP_ID };
  const calls = [];

  async function post(message) {
    const ciphertext = encryptPushMessage(message, ENCODING_AES_KEY, APP_ID);
    const msgSignature = sha1Hex([TOKEN, timestamp, nonce, ciphertext]);
    return fetch(
      `${baseUrlHolder.base}/api/payments/virtual-notify?msg_signature=${msgSignature}&timestamp=${timestamp}&nonce=${nonce}&encrypt_type=aes`,
      { method: "POST", body: JSON.stringify({ Encrypt: ciphertext }) },
    );
  }

  const baseUrlHolder = {};
  await withServer(deliveryDouble(calls), credentials, async (baseUrl) => {
    baseUrlHolder.base = baseUrl;
    const delivered = await post(DELIVERY_JSON);
    assert.equal(delivered.status, 200);
    assert.match(await delivered.text(), /<ErrCode>0<\/ErrCode>/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].outTradeNo, "order_push_1");

    const answered = await post(IOS_QUERY_JSON);
    assert.equal(answered.status, 200);
    assert.deepEqual(await answered.json(), { result_code: 1, result_info: "已发货", evidence: "tx_push_2" });
    assert.equal(calls[1][1].payOrderId, "order_push_2");
  });
});

test("POST 安全模式但 AppId 对不上时回 ErrCode=1 且不解密发货", async () => {
  const timestamp = "1700000000";
  const nonce = "nonce12345";
  const ciphertext = encryptPushMessage(DELIVERY_JSON, ENCODING_AES_KEY, "wxsomeoneelse");
  const msgSignature = sha1Hex([TOKEN, timestamp, nonce, ciphertext]);
  const calls = [];
  await withServer(deliveryDouble(calls), { token: TOKEN, encodingAesKey: ENCODING_AES_KEY, appId: APP_ID }, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/payments/virtual-notify?msg_signature=${msgSignature}&timestamp=${timestamp}&nonce=${nonce}`,
      { method: "POST", body: JSON.stringify({ Encrypt: ciphertext }) },
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<ErrCode>1<\/ErrCode>/);
    assert.equal(calls.length, 0);
  });
});
