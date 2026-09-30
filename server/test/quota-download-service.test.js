const assert = require("node:assert/strict");
const test = require("node:test");
const { PostgresQuotaDownloadService } = require("../dist/modules/downloads/quota-download-service.js");

const NOW = new Date("2026-08-31T16:30:00.000Z");

function clientPool(handler) {
  const calls = [];
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      return handler(sql, parameters, calls);
    },
    release() {
      calls.push({ sql: "RELEASE", parameters: [] });
    },
  };
  return {
    calls,
    pool: {
      async connect() { return client; },
      async query(sql, parameters = []) {
        calls.push({ sql, parameters });
        return handler(sql, parameters, calls);
      },
    },
  };
}

function quotaRow(dailyFree, usedToday, dailyRemaining, purchased) {
  return {
    daily_free: String(dailyFree),
    used_today: String(usedToday),
    daily_remaining: String(dailyRemaining),
    purchased: String(purchased),
  };
}

test("GET quota only reads and summarizes the Asia/Shanghai natural day", async () => {
  const { pool, calls } = clientPool((sql) => {
    if (sql.includes("FROM pindou_users")) return { rows: [{ id: "usr_a" }] };
    if (sql.includes("AS daily_free")) return { rows: [quotaRow(3, 1, 2, 4)] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const service = new PostgresQuotaDownloadService(pool, { dailyStandardDownloads: 3, dailyAiGenerations: 3 }, () => NOW);

  assert.deepEqual(await service.getQuota("usr_a"), {
    dailyFree: 3,
    usedToday: 1,
    purchased: 4,
    remaining: 6,
    membershipType: null,
    membershipExpiresAt: null,
    resetsAt: "2026-09-02T00:00:00+08:00",
    aiGeneration: {
      dailyFree: 3,
      usedToday: 1,
      purchased: 4,
      remaining: 6,
      resetsAt: "2026-09-02T00:00:00+08:00",
    },
  });
  assert.ok(calls.every((call) => call.sql.trim().startsWith("SELECT")));
  const summary = calls.find((call) => call.sql.includes("AS daily_free"));
  assert.deepEqual(summary.parameters, ["usr_a", "standard_download", "2026-09-01", 3]);

});

async function assertDebitBucket({ before, after, expectedBucket, expectedQuotaDate }) {
  let quotaReads = 0;
  let debitParameters;
  const { pool } = clientPool((sql, parameters) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM pindou_users")) return { rows: [{ id: "usr_a" }] };
    if (sql.includes("FROM pindou_download_records") && sql.includes("idempotency_key = $1")) return { rows: [] };
    if (sql.includes("FROM pindou_works")) return { rows: [{ user_id: "usr_a", title: "猫咪", deleted_at: null }] };
    if (sql.includes("AS daily_free")) return { rows: [quotaReads++ === 0 ? before : after] };
    if (sql.includes("INSERT INTO pindou_quota_transactions") && sql.includes("'daily_grant'")) return { rows: [] };
    if (sql.includes("INSERT INTO pindou_download_records")) return { rows: [] };
    if (sql.includes("'download_debit'")) {
      debitParameters = parameters;
      return { rows: [] };
    }
    if (sql.includes("UPDATE pindou_download_records")) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const service = new PostgresQuotaDownloadService(pool, { dailyStandardDownloads: 3, dailyAiGenerations: 3 }, () => NOW);
  const result = await service.createDownload({
    userId: "usr_a",
    idempotencyKey: `export-${expectedBucket}`,
    workId: "work_a",
    fileType: "chart",
  });
  assert.equal(debitParameters[2], expectedBucket);
  assert.equal(debitParameters[3], expectedQuotaDate);
  assert.equal(result.downloadRecord.title, "猫咪");
  assert.equal(result.downloadRecord.fileUrl, undefined);
  return result;
}

test("download consumes today's free quota before purchased quota", async () => {
  const result = await assertDebitBucket({
    before: quotaRow(3, 1, 2, 4),
    after: quotaRow(3, 2, 1, 4),
    expectedBucket: "daily_free",
    expectedQuotaDate: "2026-09-01",
  });
  assert.deepEqual(result.quota, { remaining: 5, usedToday: 2, purchased: 4 });
});

test("download consumes purchased quota after today's free quota is exhausted", async () => {
  const result = await assertDebitBucket({
    before: quotaRow(3, 3, 0, 2),
    after: quotaRow(3, 3, 0, 1),
    expectedBucket: "purchased",
    expectedQuotaDate: null,
  });
  assert.deepEqual(result.quota, { remaining: 1, usedToday: 3, purchased: 1 });
});

test("insufficient quota rolls back without a download record or negative transaction", async () => {
  const writes = [];
  const { pool, calls } = clientPool((sql) => {
    if (sql === "BEGIN" || sql === "ROLLBACK" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM pindou_users")) return { rows: [{ id: "usr_a" }] };
    if (sql.includes("FROM pindou_download_records") && sql.includes("idempotency_key = $1")) return { rows: [] };
    if (sql.includes("FROM pindou_works")) return { rows: [{ user_id: "usr_a", title: "猫咪", deleted_at: null }] };
    if (sql.includes("AS daily_free")) return { rows: [quotaRow(0, 0, 0, 0)] };
    if (sql.includes("INSERT")) writes.push(sql);
    return { rows: [] };
  });
  const service = new PostgresQuotaDownloadService(pool, { dailyStandardDownloads: 0, dailyAiGenerations: 0 }, () => NOW);
  await assert.rejects(
    () => service.createDownload({ userId: "usr_a", idempotencyKey: "no-quota", workId: "work_a", fileType: "preview" }),
    (error) => error.statusCode === 402 && error.code === "QUOTA_INSUFFICIENT",
  );
  assert.equal(writes.length, 0);
  assert.ok(calls.some((call) => call.sql === "ROLLBACK"));
});

test("same idempotency request returns the original record without another debit", async () => {
  const original = {
    id: "dl_existing",
    user_id: "usr_a",
    work_id: "work_a",
    work_title_snapshot: "历史标题",
    file_type: "materials",
    consumed_quota: true,
    quota_transaction_id: "qt_existing",
    idempotency_key: "same-export",
    downloaded_at: NOW,
  };
  const { pool, calls } = clientPool((sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM pindou_users")) return { rows: [{ id: "usr_a" }] };
    if (sql.includes("FROM pindou_download_records") && sql.includes("idempotency_key = $1")) return { rows: [original] };
    if (sql.includes("INSERT INTO pindou_quota_transactions") && sql.includes("'daily_grant'")) return { rows: [] };
    if (sql.includes("AS daily_free")) return { rows: [quotaRow(3, 1, 2, 0)] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const service = new PostgresQuotaDownloadService(pool, { dailyStandardDownloads: 3, dailyAiGenerations: 3 }, () => NOW);
  const result = await service.createDownload({ userId: "usr_a", idempotencyKey: "same-export", workId: "work_a", fileType: "materials" });
  assert.equal(result.downloadRecord.id, "dl_existing");
  assert.equal(result.downloadRecord.title, "历史标题");
  assert.equal(calls.filter((call) => call.sql.includes("'download_debit'")).length, 0);

  await assert.rejects(
    () => service.createDownload({ userId: "usr_a", idempotencyKey: "same-export", workId: "work_a", fileType: "chart" }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("download rejects a work owned by another user before writing records", async () => {
  const { pool, calls } = clientPool((sql) => {
    if (sql === "BEGIN" || sql === "ROLLBACK" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM pindou_users")) return { rows: [{ id: "usr_a" }] };
    if (sql.includes("FROM pindou_download_records") && sql.includes("idempotency_key = $1")) return { rows: [] };
    if (sql.includes("FROM pindou_works")) return { rows: [{ user_id: "usr_b", title: "他人作品", deleted_at: null }] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const service = new PostgresQuotaDownloadService(pool, { dailyStandardDownloads: 3, dailyAiGenerations: 3 }, () => NOW);
  await assert.rejects(
    () => service.createDownload({ userId: "usr_a", idempotencyKey: "foreign", workId: "work_b", fileType: "preview" }),
    (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
  );
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO pindou_download_records")).length, 0);
});

test("download history filters the authenticated user's title snapshots and never returns fileUrl", async () => {
  const row = {
    id: "dl_1",
    user_id: "usr_a",
    work_id: null,
    work_title_snapshot: "已删除的猫咪",
    file_type: "preview",
    consumed_quota: true,
    quota_transaction_id: "qt_1",
    idempotency_key: "history-1",
    downloaded_at: NOW,
  };
  const { pool, calls } = clientPool((sql) => {
    if (sql.includes("COUNT(*)")) return { rows: [{ total_count: "1" }] };
    return { rows: [row] };
  });
  const service = new PostgresQuotaDownloadService(pool, { dailyStandardDownloads: 3, dailyAiGenerations: 3 }, () => NOW);
  const result = await service.listDownloads({ userId: "usr_a", fileType: "preview", query: "猫咪", page: 2, pageSize: 1 });
  assert.equal(result.items[0].workId, null);
  assert.equal(result.items[0].title, "已删除的猫咪");
  assert.equal(result.items[0].fileUrl, undefined);
  assert.deepEqual(calls[0].parameters, ["usr_a", "preview", "%猫咪%"]);
  assert.deepEqual(calls[1].parameters, ["usr_a", "preview", "%猫咪%", 1, 1]);
});

test("palette download records are accepted and mapped as quota-consuming downloads", async () => {
  const row = {
    id: "dl_palette",
    user_id: "usr_a",
    work_id: "work_a",
    work_title_snapshot: "色板作品",
    file_type: "palette",
    consumed_quota: true,
    quota_transaction_id: "qt_palette",
    idempotency_key: "palette-history",
    downloaded_at: NOW,
  };
  const { pool } = clientPool((sql) => {
    if (sql.includes("COUNT(*)")) return { rows: [{ total_count: "1" }] };
    return { rows: [row] };
  });
  const service = new PostgresQuotaDownloadService(pool, { dailyStandardDownloads: 3, dailyAiGenerations: 3 }, () => NOW);
  const result = await service.listDownloads({ userId: "usr_a", fileType: "palette", page: 1, pageSize: 20 });
  assert.equal(result.items[0].fileType, "palette");
  assert.equal(result.items[0].consumedQuota, true);
});


test("quota preview passes each configured daily allowance to read-only ledger queries", async () => {
  const { pool, calls } = clientPool((sql, parameters) => {
    if (sql.includes("FROM pindou_users")) return { rows: [{ id: "usr_a" }] };
    assert.ok(sql.trim().startsWith("SELECT"));
    assert.equal(parameters[3], parameters[1] === "ai_generation" ? 2 : 5);
    return { rows: [quotaRow(parameters[3], 0, parameters[3], 0)] };
  });
  const service = new PostgresQuotaDownloadService(pool, { dailyStandardDownloads: 5, dailyAiGenerations: 2 }, () => NOW);
  const quota = await service.getQuota("usr_a");
  assert.equal(quota.remaining, 5);
  assert.equal(quota.aiGeneration.remaining, 2);
  assert.equal(calls.length, 3);
});
