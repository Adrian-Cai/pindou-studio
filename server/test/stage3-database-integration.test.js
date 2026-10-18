const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const test = require("node:test");
const { enabled, createIntegrationDatabase } = require("./database-integration-helpers.js");
const { PostgresWorkService } = require("../dist/modules/works/work-service.js");

test("stage 3 real database flow: idempotency, cancellation, ownership and favorite pagination", { skip: !enabled }, async () => {
  const { pool } = createIntegrationDatabase();
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
         color_count, brand, generation_mode, status, created_at, updated_at, deleted_at
       ) VALUES
         ($1, $5, '猫咪旧作', $7, 32, 32, 100, 3, 'MARD', 'standard', 'completed', $9, $9, NULL),
         ($2, $5, '风景作品', $7, 32, 32, 100, 3, 'MARD', 'standard', 'completed', $9, $9, NULL),
         ($3, $5, '猫咪新作', $7, 32, 32, 100, 3, 'MARD', 'standard', 'completed', $9, $9, NULL),
         ($4, $6, '他人作品', $8, 32, 32, 100, 3, 'MARD', 'standard', 'completed', $9, $9, NULL)`,
      [workCatOld, workOther, workCatNew, foreignWork, userA, userB, fileA, fileB, createdAt],
    );

    let favoriteClock = 0;
    const service = new PostgresWorkService(
      pool,
      () => new Date(Date.UTC(2026, 7, 29, 1, favoriteClock++)),
    );
    const first = await service.setFavorite(userA, workCatOld, true);
    const repeated = await service.setFavorite(userA, workCatOld, true);
    assert.equal(repeated.favoritedAt, first.favoritedAt);
    const firstRelation = await pool.query(
      `SELECT COUNT(*)::int AS count, MIN(created_at) AS created_at,
              MIN(favorited_at) AS favorited_at, MIN(deleted_at) AS deleted_at
         FROM pindou_favorites WHERE user_id = $1 AND work_id = $2`,
      [userA, workCatOld],
    );
    assert.equal(firstRelation.rows[0].count, 1);
    assert.equal(firstRelation.rows[0].created_at.toISOString(), first.favoritedAt);
    assert.equal(firstRelation.rows[0].favorited_at.toISOString(), first.favoritedAt);
    assert.equal(firstRelation.rows[0].deleted_at, null);

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
    const cancelledRelation = await pool.query(
      `SELECT created_at, favorited_at, deleted_at
         FROM pindou_favorites WHERE user_id = $1 AND work_id = $2`,
      [userA, workCatOld],
    );
    await service.setFavorite(userA, workCatOld, false);
    const repeatedCancellation = await pool.query(
      `SELECT COUNT(*)::int AS count, MIN(created_at) AS created_at,
              MIN(favorited_at) AS favorited_at, MIN(deleted_at) AS deleted_at
         FROM pindou_favorites WHERE user_id = $1 AND work_id = $2`,
      [userA, workCatOld],
    );
    assert.equal(repeatedCancellation.rows[0].count, 1);
    assert.equal(repeatedCancellation.rows[0].created_at.toISOString(), first.favoritedAt);
    assert.equal(repeatedCancellation.rows[0].favorited_at.toISOString(), first.favoritedAt);
    assert.equal(
      repeatedCancellation.rows[0].deleted_at.toISOString(),
      cancelledRelation.rows[0].deleted_at.toISOString(),
    );
    assert.equal((await service.listFavorites({ userId: userA, page: 1, pageSize: 20 })).items.some((item) => item.id === workCatOld), false);
    assert.equal((await service.list({ userId: userA, page: 1, pageSize: 20 })).items.find((item) => item.id === workCatOld).isFavorite, false);

    const restored = await service.setFavorite(userA, workCatOld, true);
    const restoredRelation = await pool.query(
      `SELECT COUNT(*)::int AS count, MIN(created_at) AS created_at,
              MIN(favorited_at) AS favorited_at, MIN(deleted_at) AS deleted_at
         FROM pindou_favorites WHERE user_id = $1 AND work_id = $2`,
      [userA, workCatOld],
    );
    assert.equal(restoredRelation.rows[0].count, 1);
    assert.equal(restoredRelation.rows[0].created_at.toISOString(), first.favoritedAt);
    assert.equal(restoredRelation.rows[0].favorited_at.toISOString(), restored.favoritedAt);
    assert.equal(restoredRelation.rows[0].deleted_at, null);

    const unchangedWork = await pool.query(
      "SELECT updated_at FROM pindou_works WHERE id = $1",
      [workCatOld],
    );
    assert.equal(unchangedWork.rows[0].updated_at.toISOString(), createdAt.toISOString());
  } finally {
    await pool.query("DELETE FROM pindou_favorites WHERE user_id = ANY($1::varchar[])", [userIds]);
    await pool.query("DELETE FROM pindou_works WHERE user_id = ANY($1::varchar[])", [userIds]);
    await pool.query("DELETE FROM pindou_file_assets WHERE user_id = ANY($1::varchar[])", [userIds]);
    await pool.query("DELETE FROM pindou_users WHERE id = ANY($1::varchar[])", [userIds]);
    await pool.end();
  }
});
