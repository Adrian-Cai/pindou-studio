const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const test = require("node:test");
const { loadLocalEnv, readConfig } = require("../dist/config/env.js");
const { createPool } = require("../dist/db/pool.js");
const { PostgresWorkService } = require("../dist/modules/works/work-service.js");

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";

test("stage 3 real database flow: idempotency, cancellation, ownership and favorite pagination", { skip: !enabled }, async () => {
  loadLocalEnv();
  const config = readConfig();
  const pool = createPool(config.database);
  const suffix = randomBytes(6).toString("hex");
  const userA = `usr_fa_${suffix}`;
  const userB = `usr_fb_${suffix}`;
  const fileA = `file_fa_${suffix}`;
  const fileB = `file_fb_${suffix}`;
  const workCatOld = `work_f1_${suffix}`;
  const workOther = `work_f2_${suffix}`;
  const workCatNew = `work_f3_${suffix}`;
  const foreignWork = `work_fb_${suffix}`;
  const userIds = [userA, userB];

  try {
    const createdAt = new Date("2026-08-29T00:00:00.000Z");
    await pool.query(
      `INSERT INTO pindou_users (
         id, openid_hash, openid_ciphertext, nickname, avatar_url, created_at, updated_at, deleted_at
       ) VALUES
         ($1, $3, NULL, '收藏用户A', NULL, $5, $5, NULL),
         ($2, $4, NULL, '收藏用户B', NULL, $5, $5, NULL)`,
      [userA, userB, `favorite_a_${suffix}`, `favorite_b_${suffix}`, createdAt],
    );
    await pool.query(
      `INSERT INTO pindou_file_assets (
         id, user_id, file_type, object_key, public_url, content_type,
         byte_size, width, height, created_at, deleted_at
       ) VALUES
         ($1, $3, 'cover', $5, $7, 'image/png', 1, 1, 1, $9, NULL),
         ($2, $4, 'cover', $6, $8, 'image/png', 1, 1, 1, $9, NULL)`,
      [fileA, fileB, userA, userB, `covers/${fileA}.png`, `covers/${fileB}.png`, `https://cdn.example/${fileA}.png`, `https://cdn.example/${fileB}.png`, createdAt],
    );
    await pool.query(
      `INSERT INTO pindou_works (
         id, user_id, title, cover_file_id, width, height, bead_count,
         color_count, brand, status, created_at, updated_at, deleted_at
       ) VALUES
         ($1, $5, '猫咪旧作', $7, 32, 32, 100, 3, 'MARD', 'completed', $9, $9, NULL),
         ($2, $5, '风景作品', $7, 32, 32, 100, 3, 'MARD', 'completed', $9, $9, NULL),
         ($3, $5, '猫咪新作', $7, 32, 32, 100, 3, 'MARD', 'completed', $9, $9, NULL),
         ($4, $6, '他人作品', $8, 32, 32, 100, 3, 'MARD', 'completed', $9, $9, NULL)`,
      [workCatOld, workOther, workCatNew, foreignWork, userA, userB, fileA, fileB, createdAt],
    );

    const favoriteTimes = [
      new Date("2026-08-29T01:00:00.000Z"),
      new Date("2026-08-29T01:01:00.000Z"),
      new Date("2026-08-29T01:02:00.000Z"),
      new Date("2026-08-29T01:03:00.000Z"),
    ];
    const service = new PostgresWorkService(pool, () => favoriteTimes.shift() ?? new Date("2026-08-29T02:00:00.000Z"));
    const first = await service.setFavorite(userA, workCatOld, true);
    const repeated = await service.setFavorite(userA, workCatOld, true);
    assert.equal(repeated.favoritedAt, first.favoritedAt);
    const duplicateCount = await pool.query(
      "SELECT COUNT(*)::int AS count FROM pindou_favorites WHERE user_id = $1 AND work_id = $2",
      [userA, workCatOld],
    );
    assert.equal(duplicateCount.rows[0].count, 1);

    await service.setFavorite(userA, workOther, true);
    await service.setFavorite(userA, workCatNew, true);
    const firstPage = await service.listFavorites({ userId: userA, query: "猫咪", page: 1, pageSize: 1 });
    const secondPage = await service.listFavorites({ userId: userA, query: "猫咪", page: 2, pageSize: 1 });
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.items[0].id, workCatNew);
    assert.equal(firstPage.items[0].pattern, undefined);
    assert.equal(secondPage.items[0].id, workCatOld);

    await assert.rejects(() => service.setFavorite(userA, foreignWork, true), (error) => error.code === "FORBIDDEN");
    await assert.rejects(() => service.setFavorite(userA, foreignWork, false), (error) => error.code === "FORBIDDEN");

    await service.setFavorite(userA, workCatOld, false);
    await service.setFavorite(userA, workCatOld, false);
    const cancelledCount = await pool.query(
      "SELECT COUNT(*)::int AS count FROM pindou_favorites WHERE user_id = $1 AND work_id = $2",
      [userA, workCatOld],
    );
    assert.equal(cancelledCount.rows[0].count, 0);
  } finally {
    await pool.query("DELETE FROM pindou_favorites WHERE user_id = ANY($1::varchar[])", [userIds]);
    await pool.query("DELETE FROM pindou_works WHERE user_id = ANY($1::varchar[])", [userIds]);
    await pool.query("DELETE FROM pindou_file_assets WHERE user_id = ANY($1::varchar[])", [userIds]);
    await pool.query("DELETE FROM pindou_users WHERE id = ANY($1::varchar[])", [userIds]);
    await pool.end();
  }
});
