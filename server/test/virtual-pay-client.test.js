const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const test = require("node:test");
const { createVirtualPayGateway } = require("../dist/modules/payments/virtual-pay-client.js");

/**
 * 虚拟支付查单的协议守卫。
 *
 * 这些用例存在的理由是一次真实故障：查单没带 access_token，接口稳定返回 41001，
 * 于是**所有**发货验真失败 —— 用户付了钱、发货推送也到了，权益却永远发不出去，
 * 服务端日志只有一句「虚拟支付订单查询失败（41001）」，看不出是协议用错了。
 * 因此这里断言的是**请求形状**（token/pay_sig 在 query 上、请求体只有三个字段）
 * 与**响应解析**（订单信息在 order 对象里、状态是数字枚举），而不只是「不报错」。
 */

const APP_KEY = "test-app-key";
const APP_ID = "wx-test-app";
const APP_SECRET = "test-app-secret";
const BASE_URL = "https://api.weixin.qq.com";

function gateway(fetcher) {
  return createVirtualPayGateway(
    {
      enabled: true,
      appId: APP_ID,
      offerId: "offer-1",
      appKey: APP_KEY,
      timeoutMs: 5_000,
      apiBaseUrl: BASE_URL,
    },
    APP_SECRET,
    fetcher,
  );
}

/** 记录所有请求，并按 URL 前缀分派应答。 */
function recorder(handler) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, body: typeof init.body === "string" ? init.body : null });
    return handler(url, calls.length);
  };
  return { calls, fetcher };
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function tokenResponse(token = "token-1") {
  return jsonResponse({ access_token: token, expires_in: 7200 });
}

/** 已支付订单：status=2（已支付待发货）。 */
function queryResponse(status = 2) {
  return jsonResponse({
    errcode: 0,
    errmsg: "",
    order: {
      order_id: "order_1",
      status,
      order_fee: 10,
      paid_fee: 10,
      paid_time: 1_760_000_000,
      wx_order_id: "wx-inner-1",
      wxpay_order_id: "wxpay-1",
      channel_order_id: "channel-1",
    },
  });
}

function queryFetcher(options = {}) {
  return recorder((url, callCount) => {
    if (url.includes("/cgi-bin/token")) return tokenResponse(options.token ?? "token-1");
    if (url.includes("/xpay/query_order")) {
      if (options.tokenErrorAt === callCount) return jsonResponse({ errcode: 42001, errmsg: "access_token expired" });
      return options.queryError
        ? jsonResponse({ errcode: options.queryError, errmsg: "boom" })
        : queryResponse(options.status ?? 2);
    }
    throw new Error(`未预期的请求：${url}`);
  });
}

test("query_order 把 access_token 与 pay_sig 放在 query string 上，而不是请求体里", async () => {
  const { calls, fetcher } = queryFetcher();
  await gateway(fetcher).queryOrder({ openid: "openid-1", outTradeNo: "order_1" });

  const queryCall = calls.find((call) => call.url.includes("/xpay/query_order"));
  const url = new URL(queryCall.url);
  assert.equal(url.searchParams.get("access_token"), "token-1");
  assert.match(url.searchParams.get("pay_sig") ?? "", /^[0-9a-f]{64}$/);

  // 请求体必须只有 openid / env / order_id：多带 appid 或 pay_sig 都不符合官方口径
  assert.deepEqual(Object.keys(JSON.parse(queryCall.body)).sort(), ["env", "openid", "order_id"]);
});

test("pay_sig 用请求体原文签名，uri 不带域名", async () => {
  const { calls, fetcher } = queryFetcher();
  await gateway(fetcher).queryOrder({ openid: "openid-1", outTradeNo: "order_1" });

  const queryCall = calls.find((call) => call.url.includes("/xpay/query_order"));
  const expected = createHmac("sha256", APP_KEY)
    .update(`/xpay/query_order&${queryCall.body}`, "utf8")
    .digest("hex");
  assert.equal(new URL(queryCall.url).searchParams.get("pay_sig"), expected);
});

test("已支付订单从 order 对象解析出金额与交易号", async () => {
  const { fetcher } = queryFetcher({ status: 2 });
  const result = await gateway(fetcher).queryOrder({ openid: "openid-1", outTradeNo: "order_1" });

  assert.equal(result.paid, true);
  assert.equal(result.actualPriceFen, 10);
  assert.equal(result.paidTimeSeconds, 1_760_000_000);
  assert.equal(result.transactionId, "wxpay-1");
  assert.equal(result.mchOrderNo, "channel-1");
});

test("未支付与已退款状态一律不判为已支付（fail-closed）", async () => {
  for (const status of [0, 1, 5, 6, 8]) {
    const { fetcher } = queryFetcher({ status });
    const result = await gateway(fetcher).queryOrder({ openid: "openid-1", outTradeNo: "order_1" });
    assert.equal(result.paid, false, `status=${status} 不应判为已支付`);
  }
});

test("order 对象缺失时不判已支付，绝不靠顶层字段兜底", async () => {
  const { fetcher } = recorder((url) => {
    if (url.includes("/cgi-bin/token")) return tokenResponse();
    // 顶层给了看起来像已支付的字段，但官方结构体里它们不算数
    return jsonResponse({ errcode: 0, errmsg: "", pay_state: "PAID", actual_price: 10 });
  });
  const result = await gateway(fetcher).queryOrder({ openid: "openid-1", outTradeNo: "order_1" });
  assert.equal(result.paid, false);
});

test("access_token 失效时换 token 重试一次后成功", async () => {
  const { calls, fetcher } = queryFetcher({ tokenErrorAt: 2 });
  const result = await gateway(fetcher).queryOrder({ openid: "openid-1", outTradeNo: "order_1" });

  assert.equal(result.paid, true);
  const tokenCalls = calls.filter((call) => call.url.includes("/cgi-bin/token"));
  const queryCalls = calls.filter((call) => call.url.includes("/xpay/query_order"));
  assert.equal(tokenCalls.length, 2, "token 失效后应重新换取");
  assert.equal(queryCalls.length, 2, "应在新 token 下重试一次");
});

test("查单返回非 0 错误码时抛出带错误码的异常，便于定位", async () => {
  const { fetcher } = queryFetcher({ queryError: 41001 });
  await assert.rejects(
    () => gateway(fetcher).queryOrder({ openid: "openid-1", outTradeNo: "order_1" }),
    /虚拟支付订单查询失败（41001）/,
  );
});

test("access_token 在有效期内被复用，不每次查单都换取", async () => {
  const { calls, fetcher } = queryFetcher();
  const client = gateway(fetcher);
  await client.queryOrder({ openid: "openid-1", outTradeNo: "order_1" });
  await client.queryOrder({ openid: "openid-1", outTradeNo: "order_2" });

  const tokenCalls = calls.filter((call) => call.url.includes("/cgi-bin/token"));
  assert.equal(tokenCalls.length, 1);
});
