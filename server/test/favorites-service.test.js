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
    is_favorite: true,
  };
}

test("duplicate favorite and repeated cancellation are idempotent", async () => {
  let storedCreatedAt = null;
  let insertSql = "";
  let deleteCount = 0;
  let clock = 0;
  const pool = {
    async query(sql, parameters) {
      if (sql.startsWith("SELECT user_id, deleted_at")) {
        return { rows: [{ user_id: "usr_current", deleted_at: null }] };
      }
      if (sql.includes("INSERT INTO pindou_favorites")) {
        insertSql = sql;
        storedCreatedAt ??= parameters[2];
        return { rows: [{ created_at: storedCreatedAt }] };
      }
      if (sql.includes("DELETE FROM pindou_favorites")) {
        deleteCount += 1;
        storedCreatedAt = null;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const service = new PostgresWorkService(pool, () => new Date(Date.UTC(2026, 7, 29, 1, clock++)));

  const first = await service.setFavorite("usr_current", "work_test", true);
  const repeated = await service.setFavorite("usr_current", "work_test", true);
  assert.equal(first.favoritedAt, "2026-08-29T01:00:00.000Z");
  assert.equal(repeated.favoritedAt, first.favoritedAt);
  assert.match(insertSql, /ON CONFLICT \(user_id, work_id\) DO UPDATE/u);

  const cancelled = await service.setFavorite("usr_current", "work_test", false);
  const repeatedCancellation = await service.setFavorite("usr_current", "work_test", false);
  assert.deepEqual(cancelled, { workId: "work_test", isFavorite: false, favoritedAt: null });
  assert.deepEqual(repeatedCancellation, cancelled);
  assert.equal(deleteCount, 2);
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
  assert.deepEqual(queries[0].parameters, ["usr_current", "%猫咪%"]);
  assert.deepEqual(queries[1].parameters, ["usr_current", "%猫咪%", 2, 2]);
  assert.match(queries[1].sql, /ORDER BY favorites\.created_at DESC, works\.id DESC/u);
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
