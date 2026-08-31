const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const test = require("node:test");
const { loadLocalEnv, readConfig } = require("../dist/config/env.js");
const { createPool } = require("../dist/db/pool.js");
const { PostgresQuotaDownloadService } = require("../dist/modules/downloads/quota-download-service.js");

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";

test("stage 4 real database flow: grants, purchased quota, concurrency, insufficiency, idempotency and ownership", { skip: !enabled }, async () => {
  loadLocalEnv();
  const config = readConfig();
  const pool = createPool(config.database);
  const suffix = randomBytes(6).toString("hex");
  const userA = `usr_dla_${suffix}`;
  const userB = `usr_dlb_${suffix}`;
  const fileA = `file_dla_${suffix}`;
  const fileB = `file_dlb_${suffix}`;
  const workA = `work_dla_${suffix}`;
  const workB = `work_dlb_${suffix}`;
  const userIds = [userA, userB];
  const now = new Date("2026-08-31T16:30:00.000Z");

  try {
    await pool.query(
      `INSERT INTO pindou_users (
         id, openid_hash, openid_ciphertext, nickname, avatar_url, created_at, updated_at, deleted_at
       ) VALUES
         ($1, $3, NULL, '下载用户A', NULL, $5, $5, NULL),
         ($2, $4, NULL, '下载用户B', NULL, $5, $5, NULL)`,
      [userA, userB, `download_a_${suffix}`, `download_b_${suffix}`, now],
    );
    await pool.query(
      `INSERT INTO pindou_file_assets (
         id, user_id, file_type, object_key, public_url, content_type,
         byte_size, width, height, created_at, deleted_at
       ) VALUES
         ($1, $3, 'cover', $5, $7, 'image/png', 1, 1, 1, $9, NULL),
         ($2, $4, 'cover', $6, $8, 'image/png', 1, 1, 1, $9, NULL)`,
      [fileA, fileB, userA, userB, `covers/${fileA}.png`, `covers/${fileB}.png`, `https://cdn.example/${fileA}.png`, `https://cdn.example/${fileB}.png`, now],
    );
    await pool.query(
      `INSERT INTO pindou_works (
         id, user_id, title, cover_file_id, width, height, bead_count,
         color_count, brand, status, created_at, updated_at, deleted_at
       ) VALUES
         ($1, $3, '猫咪下载作品', $5, 32, 32, 100, 3, 'MARD', 'completed', $7, $7, NULL),
         ($2, $4, '他人下载作品', $6, 32, 32, 100, 3, 'MARD', 'completed', $7, $7, NULL)`,
      [workA, workB, userA, userB, fileA, fileB, now],
    );
    await pool.query(
      `INSERT INTO pindou_quota_transactions (
         id, user_id, type, amount, source, bucket, quota_date, order_id,
         download_record_id, idempotency_key, note, created_at
       ) VALUES
         ($1, $3, 'adjustment', 2, 'support', 'purchased', NULL, NULL, NULL, NULL, '测试购买额度', $4),
         ($2, $3, 'adjustment', -2, 'support', 'daily_free', '2026-08-31', NULL, NULL, NULL, '前一上海自然日流水', $4)`,
      [`qt_buy_${suffix}`, `qt_old_${suffix}`, userA, now],
    );

    const service = new PostgresQuotaDownloadService(pool, { dailyFree: 3 }, () => now);
    const firstQuota = await service.getQuota(userA);
    const repeatedQuota = await service.getQuota(userA);
    assert.deepEqual(firstQuota, {
      dailyFree: 3,
      usedToday: 0,
      purchased: 2,
      remaining: 5,
      membershipType: null,
      membershipExpiresAt: null,
      resetsAt: "2026-09-02T00:00:00+08:00",
    });
    assert.deepEqual(repeatedQuota, firstQuota);
    const grantCount = await pool.query(
      "SELECT COUNT(*)::int AS count FROM pindou_quota_transactions WHERE user_id = $1 AND type = 'daily_grant' AND quota_date = '2026-09-01'",
      [userA],
    );
    assert.equal(grantCount.rows[0].count, 1);

    const successful = [];
    for (let index = 1; index <= 4; index += 1) {
      successful.push(await service.createDownload({
        userId: userA,
        idempotencyKey: `stage4-${suffix}-${index}`,
        workId: workA,
        fileType: index % 2 === 0 ? "chart" : "preview",
      }));
    }
    assert.equal(successful[2].quota.usedToday, 3);
    assert.equal(successful[3].quota.purchased, 1);
    const firstBuckets = await pool.query(
      `SELECT bucket
         FROM pindou_quota_transactions
        WHERE user_id = $1 AND type = 'download_debit'
        ORDER BY created_at, id`,
      [userA],
    );
    assert.deepEqual(firstBuckets.rows.map((row) => row.bucket).sort(), ["daily_free", "daily_free", "daily_free", "purchased"].sort());

    const duplicate = await service.createDownload({
      userId: userA,
      idempotencyKey: `stage4-${suffix}-4`,
      workId: workA,
      fileType: "chart",
    });
    assert.equal(duplicate.downloadRecord.id, successful[3].downloadRecord.id);
    await assert.rejects(
      () => service.createDownload({ userId: userA, idempotencyKey: `stage4-${suffix}-4`, workId: workA, fileType: "materials" }),
      (error) => error.code === "IDEMPOTENCY_CONFLICT",
    );

    const concurrent = await Promise.allSettled([
      service.createDownload({ userId: userA, idempotencyKey: `stage4-${suffix}-concurrent-a`, workId: workA, fileType: "materials" }),
      service.createDownload({ userId: userA, idempotencyKey: `stage4-${suffix}-concurrent-b`, workId: workA, fileType: "materials" }),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = concurrent.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "QUOTA_INSUFFICIENT");

    const beforeInsufficient = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM pindou_download_records WHERE user_id = $1)::int AS downloads,
         (SELECT COUNT(*) FROM pindou_quota_transactions WHERE user_id = $1 AND amount < 0)::int AS negative_transactions`,
      [userA],
    );
    assert.deepEqual(beforeInsufficient.rows[0], { downloads: 5, negative_transactions: 6 });
    await assert.rejects(
      () => service.createDownload({ userId: userA, idempotencyKey: `stage4-${suffix}-insufficient`, workId: workA, fileType: "preview" }),
      (error) => error.statusCode === 402 && error.code === "QUOTA_INSUFFICIENT",
    );
    await assert.rejects(
      () => service.createDownload({ userId: userA, idempotencyKey: `stage4-${suffix}-foreign`, workId: workB, fileType: "preview" }),
      (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
    );
    const afterFailures = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM pindou_download_records WHERE user_id = $1)::int AS downloads,
         (SELECT COUNT(*) FROM pindou_quota_transactions WHERE user_id = $1 AND amount < 0)::int AS negative_transactions`,
      [userA],
    );
    assert.deepEqual(afterFailures.rows[0], beforeInsufficient.rows[0]);

    await pool.query("UPDATE pindou_works SET deleted_at = $2 WHERE id = $1", [workA, new Date(now.getTime() + 1_000)]);
    const history = await service.listDownloads({ userId: userA, query: "猫咪", page: 1, pageSize: 20 });
    assert.equal(history.total, 5);
    assert.ok(history.items.every((item) => item.title === "猫咪下载作品"));
    assert.ok(history.items.every((item) => item.fileUrl === undefined));

    const finalQuota = await service.getQuota(userA);
    assert.deepEqual({ usedToday: finalQuota.usedToday, purchased: finalQuota.purchased, remaining: finalQuota.remaining }, { usedToday: 3, purchased: 0, remaining: 0 });
    const rawBalances = await pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE bucket = 'daily_free' AND quota_date = '2026-09-01'), 0)::int AS daily_balance,
         COALESCE(SUM(amount) FILTER (WHERE bucket = 'purchased'), 0)::int AS purchased_balance
       FROM pindou_quota_transactions
       WHERE user_id = $1`,
      [userA],
    );
    assert.deepEqual(rawBalances.rows[0], { daily_balance: 0, purchased_balance: 0 });
  } finally {
    await pool.query("UPDATE pindou_download_records SET quota_transaction_id = NULL WHERE user_id = ANY($1::varchar[])", [userIds]);
    await pool.query("DELETE FROM pindou_quota_transactions WHERE user_id = ANY($1::varchar[])", [userIds]);
    await pool.query("DELETE FROM pindou_download_records WHERE user_id = ANY($1::varchar[])", [userIds]);
    await pool.query("DELETE FROM pindou_works WHERE user_id = ANY($1::varchar[])", [userIds]);
    await pool.query("DELETE FROM pindou_file_assets WHERE user_id = ANY($1::varchar[])", [userIds]);
    await pool.query("DELETE FROM pindou_users WHERE id = ANY($1::varchar[])", [userIds]);
    await pool.end();
  }
});
