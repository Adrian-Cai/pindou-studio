const assert = require("node:assert/strict");
const test = require("node:test");
const { PostgresWorkService } = require("../dist/modules/works/work-service.js");

function workRow(id, title) {
  return {
    id,
    user_id: "usr_current",
    title,
    cover_file_id: "file_cover",
    cover_url: "https://cdn.example/cover.png",
    width: 32,
    height: 32,
    bead_count: 100,
    color_count: 3,
    brand: "MARD",
    status: "completed",
    created_at: new Date("2026-08-27T01:00:00.000Z"),
    updated_at: new Date("2026-08-27T02:00:00.000Z"),
    deleted_at: null,
    favorited_at: new Date("2026-09-02T03:00:00.000Z"),
    is_favorite: true,
  };
}

test("favorite lifecycle preserves one row and all idempotent timestamps", async () => {
  let stored = null;
  const mutationSql = [];
  const times = [
    "2026-09-01T01:00:00.000Z",
    "2026-09-01T02:00:00.000Z",
    "2026-09-01T03:00:00.000Z",
    "2026-09-01T04:00:00.000Z",
    "2026-09-01T05:00:00.000Z",
    "2026-09-01T06:00:00.000Z",
  ].map((value) => new Date(value));
  const pool = {
    async query(sql, parameters) {
      if (sql.startsWith("SELECT user_id, deleted_at")) {
        return { rows: [{ user_id: "usr_current", deleted_at: null }] };
      }
      if (sql.includes("INSERT INTO pindou_favorites")) {
        mutationSql.push(sql);
        if (!stored) {
          stored = { createdAt: parameters[2], favoritedAt: parameters[2], deletedAt: null };
        } else if (stored.deletedAt) {
          stored.favoritedAt = parameters[2];
          stored.deletedAt = null;
        }
        return { rows: [{ favorited_at: stored.favoritedAt }] };
      }
      if (sql.includes("UPDATE pindou_favorites")) {
        mutationSql.push(sql);
        if (stored && !stored.deletedAt) stored.deletedAt = parameters[2];
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const service = new PostgresWorkService(pool, () => times.shift());

  const neverFavoritedCancellation = await service.setFavorite("usr_current", "work_test", false);
  assert.deepEqual(neverFavoritedCancellation, { workId: "work_test", isFavorite: false, favoritedAt: null });
  assert.equal(stored, null);

  const first = await service.setFavorite("usr_current", "work_test", true);
  const repeated = await service.setFavorite("usr_current", "work_test", true);
  assert.equal(first.favoritedAt, "2026-09-01T02:00:00.000Z");
  assert.equal(repeated.favoritedAt, first.favoritedAt);
  assert.equal(stored.createdAt.toISOString(), "2026-09-01T02:00:00.000Z");
  assert.match(mutationSql[1], /WHERE pindou_favorites\.deleted_at IS NOT NULL/u);
  assert.match(mutationSql[1], /FROM pindou_works/u);
  assert.match(mutationSql[1], /pindou_works[\s\S]*deleted_at IS NULL/u);

  const cancelled = await service.setFavorite("usr_current", "work_test", false);
  const firstDeletedAt = stored.deletedAt;
  const repeatedCancellation = await service.setFavorite("usr_current", "work_test", false);
  assert.deepEqual(cancelled, { workId: "work_test", isFavorite: false, favoritedAt: null });
  assert.deepEqual(repeatedCancellation, cancelled);
  assert.equal(stored.deletedAt, firstDeletedAt);
  assert.equal(stored.favoritedAt.toISOString(), "2026-09-01T02:00:00.000Z");

  const restored = await service.setFavorite("usr_current", "work_test", true);
  assert.equal(restored.favoritedAt, "2026-09-01T06:00:00.000Z");
  assert.equal(stored.createdAt.toISOString(), "2026-09-01T02:00:00.000Z");
  assert.equal(stored.deletedAt, null);
  assert.equal(mutationSql.some((sql) => sql.includes("DELETE FROM pindou_favorites")), false);
  assert.equal(mutationSql.some((sql) => sql.includes("UPDATE pindou_works")), false);
});

test("concurrent duplicate favorite reads the committed active relation", async () => {
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith("SELECT user_id, deleted_at")) {
        return { rows: [{ user_id: "usr_current", deleted_at: null }] };
      }
      if (sql.includes("INSERT INTO pindou_favorites")) return { rows: [] };
      if (sql.includes("SELECT favorites.favorited_at")) {
        return { rows: [{ favorited_at: new Date("2026-09-01T01:00:00.000Z") }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const service = new PostgresWorkService(pool, () => new Date("2026-09-01T02:00:00.000Z"));

  const result = await service.setFavorite("usr_current", "work_test", true);

  assert.equal(result.favoritedAt, "2026-09-01T01:00:00.000Z");
  assert.match(queries[2], /works\.deleted_at IS NULL/u);
});

test("favorite list paginates summaries by latest favorite time without loading pattern", async () => {
  const queries = [];
  const pool = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      if (sql.includes("COUNT(*)")) return { rows: [{ total_count: "3" }] };
      return { rows: [workRow("work_newer", "猫咪二号"), workRow("work_older", "猫咪一号")] };
    },
  };
  const service = new PostgresWorkService(pool);
  const result = await service.listFavorites({ userId: "usr_current", query: "猫咪", page: 2, pageSize: 2 });

  assert.equal(result.total, 3);
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 2);
  assert.deepEqual(result.items.map((item) => item.id), ["work_newer", "work_older"]);
  assert.equal(result.items.every((item) => item.isFavorite && item.pattern === undefined), true);
  assert.equal(result.items[0].favoritedAt, "2026-09-02T03:00:00.000Z");
  assert.deepEqual(queries[0].parameters, ["usr_current", "%猫咪%"]);
  assert.deepEqual(queries[1].parameters, ["usr_current", "%猫咪%", 2, 2]);
  assert.match(queries[0].sql, /favorites\.deleted_at IS NULL/u);
  assert.match(queries[1].sql, /favorites\.deleted_at IS NULL/u);
  assert.match(queries[1].sql, /ORDER BY favorites\.favorited_at DESC, works\.id DESC/u);
  assert.equal(queries[1].sql.includes("pindou_work_patterns"), false);
  assert.equal(queries[1].sql.includes("cells_json"), false);
  assert.match(queries[1].sql, /works\.user_id = favorites\.user_id/u);
});

test("a user cannot favorite or cancel a different user's work", async () => {
  let mutationCount = 0;
  const pool = {
    async query(sql) {
      if (sql.startsWith("SELECT user_id, deleted_at")) {
        return { rows: [{ user_id: "usr_b", deleted_at: null }] };
      }
      mutationCount += 1;
      return { rows: [] };
    },
  };
  const service = new PostgresWorkService(pool);
  await assert.rejects(() => service.setFavorite("usr_a", "work_b", true), (error) => error.code === "FORBIDDEN");
  await assert.rejects(() => service.setFavorite("usr_a", "work_b", false), (error) => error.code === "FORBIDDEN");
  assert.equal(mutationCount, 0);
});
