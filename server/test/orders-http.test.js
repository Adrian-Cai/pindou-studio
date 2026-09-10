const assert = require("node:assert/strict");
const test = require("node:test");
const { AppError } = require("../dist/shared/app-error.js");
const { createHttpApplication } = require("../dist/http/app.js");
const { PostgresPaymentService } = require("../dist/modules/payments/payment-service.js");
const { startHttpServer } = require("../dist/http/server.js");

async function withServer(payments, run) {
  const unused = new Proxy({}, { get() { return async () => { throw new Error("unexpected dependency call"); }; } });
  const running = await startHttpServer(createHttpApplication({
    database: { async check() { return { status: "up", product: "PostgreSQL", version: "17.11", schemaStatus: "valid" }; } },
    auth: unused,
    authenticator: {
      async authenticate(value) {
        if (value !== "Bearer valid-order-token-1234567890") {
          throw new AppError(401, "UNAUTHORIZED", "请先登录");
        }
        return { id: "usr_current" };
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
    aiFileMaximumBytes: 1024,
    aiGenerations: unused,
    contentSecurity: unused,
  }), "127.0.0.1", 0);
  try {
    await run(`http://127.0.0.1:${running.port}`);
  } finally {
    await running.close();
  }
}

test("GET /api/orders authenticates through Bearer token and validates pagination", async () => {
  const received = [];
  await withServer({
    async listOrders(options) {
      received.push(options);
      return { total: 0, page: options.page, pageSize: options.pageSize, items: [] };
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/orders?page=2&pageSize=5`, {
      headers: { authorization: "Bearer valid-order-token-1234567890" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { total: 0, page: 2, pageSize: 5, items: [] });
    assert.deepEqual(received, [{ userId: "usr_current", page: 2, pageSize: 5 }]);

    for (const query of ["page=0", "pageSize=51", "page=1&page=2", "userId=usr_other"]) {
      const invalid = await fetch(`${baseUrl}/api/orders?${query}`, {
        headers: { authorization: "Bearer valid-order-token-1234567890" },
      });
      assert.equal(invalid.status, 400, query);
    }
    assert.equal(received.length, 1);
  });
});

function orderRow(overrides = {}) {
  return {
    id: "order_paid_1",
    package_id: "ai_generation_80",
    package_label_snapshot: "AI 精致生成 80 次",
    quota_amount_snapshot: 80,
    quota_kind_snapshot: "ai_generation",
    price_fen: 1990,
    status: "paid",
    created_at: new Date("2026-09-10T06:30:00.000Z"),
    paid_at: new Date("2026-09-10T06:31:00.000Z"),
    wx_prepay_id: "must-not-leak",
    wx_transaction_id: "must-not-leak-either",
    ...overrides,
  };
}

function serviceWithRows(rows, total = rows.length) {
  const calls = [];
  const pool = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes("COUNT(*)")) return { rows: [{ total }] };
      return { rows: rows.filter((row) => row.quota_kind_snapshot === "ai_generation") };
    },
  };
  return { service: new PostgresPaymentService(pool, {}, "unused-secret"), calls };
}

test("order list uses only the current user, sorts by creation time, returns snapshots, filters non-AI rows, and hides payment fields", async () => {
  const rows = [
    orderRow({ id: "order_new", package_label_snapshot: "AI 精致生成 150 次", quota_amount_snapshot: 150, price_fen: 2990, created_at: new Date("2026-09-10T07:00:00.000Z") }),
    orderRow({ id: "order_old", created_at: new Date("2026-09-09T07:00:00.000Z") }),
    orderRow({ id: "order_download", package_label_snapshot: "下载次数 10 次", quota_amount_snapshot: 10, quota_kind_snapshot: "download", price_fen: 990 }),
  ];
  const { service, calls } = serviceWithRows(rows, 2);
  const response = await service.listOrders({ userId: "usr_current", page: 1, pageSize: 20 });

  assert.deepEqual(response, {
    total: 2,
    page: 1,
    pageSize: 20,
    items: [
      {
        id: "order_new",
        packageId: "ai_generation_80",
        packageLabel: "AI 精致生成 150 次",
        quotaAmount: 150,
        quotaKind: "ai_generation",
        priceFen: 2990,
        currency: "CNY",
        status: "paid",
        createdAt: "2026-09-10T07:00:00.000Z",
        paidAt: "2026-09-10T06:31:00.000Z",
      },
      {
        id: "order_old",
        packageId: "ai_generation_80",
        packageLabel: "AI 精致生成 80 次",
        quotaAmount: 80,
        quotaKind: "ai_generation",
        priceFen: 1990,
        currency: "CNY",
        status: "paid",
        createdAt: "2026-09-09T07:00:00.000Z",
        paidAt: "2026-09-10T06:31:00.000Z",
      },
    ],
  });
  assert.equal(calls[0].parameters[0], "usr_current");
  assert.equal(calls[1].parameters[0], "usr_current");
  assert.equal(calls[1].parameters[1], 20);
  assert.equal(calls[1].parameters[2], 0);
  assert.match(calls[1].sql, /quota_kind_snapshot = 'ai_generation'/);
  assert.match(calls[1].sql, /ORDER BY created_at DESC, id DESC/);
  assert.equal(response.items[0].wx_prepay_id, undefined);
  assert.equal(response.items[0].wx_transaction_id, undefined);
});

test("empty order list is returned without loading package configuration", async () => {
  const { service, calls } = serviceWithRows([], 0);
  const response = await service.listOrders({ userId: "usr_empty", page: 3, pageSize: 5 });
  assert.deepEqual(response, { total: 0, page: 3, pageSize: 5, items: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => call.sql.includes("pindou_packages")), false);
});

test("all supported order statuses remain explicit in the API response", async () => {
  const statuses = ["pending", "paid", "failed", "closed", "refunded"];
  const { service } = serviceWithRows(statuses.map((status, index) => orderRow({ id: `order_${index}`, status })));
  const response = await service.listOrders({ userId: "usr_status", page: 1, pageSize: 20 });
  assert.deepEqual(response.items.map((item) => item.status), statuses);
});
