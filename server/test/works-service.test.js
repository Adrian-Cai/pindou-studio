const assert = require("node:assert/strict");
const { mkdtemp, rm, unlink, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");
const { PostgresWorkService } = require("../dist/modules/works/work-service.js");
const { validatePersistedPattern } = require("../dist/modules/works/pattern.js");
const { createIdempotentWorkId } = require("../dist/shared/identity.js");

function pattern() {
  return { schemaVersion: 1, width: 32, height: 32, settings: { colorLimit: 2, brand: "MARD" }, palette: [{ code: "C01", color: "#111111" }, { code: "C02", color: "#222222" }], cells: [0, 1, -1].concat(Array(1021).fill(-1)) };
}

function largePattern() {
  return { schemaVersion: 1, width: 128, height: 128, settings: { colorLimit: 1, brand: "MARD" }, palette: [{ code: "C01", color: "#111111" }], cells: Array(16_384).fill(0) };
}

function row(workId, title = "作品") {
  return { id: workId, user_id: "usr_current", title, cover_file_id: "file_cover", cover_url: "https://cdn/cover.png", width: 32, height: 32, bead_count: 2, color_count: 2, brand: "MARD", status: "completed", created_at: new Date("2026-08-27T01:00:00.000Z"), updated_at: new Date("2026-08-27T01:00:00.000Z"), deleted_at: null, schema_version: 1, color_limit: 2, pattern_brand: "MARD", palette_json: [{ code: "C01", color: "#111111" }, { code: "C02", color: "#222222" }], cells_json: [0, 1, -1].concat(Array(1021).fill(-1)) };
}

test("save writes work and pattern in one transaction and derives counts", async () => {
  const calls = [];
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM pindou_works works")) return { rows: [] };
      if (sql.includes("FROM pindou_file_assets")) return { rows: [{ user_id: "usr_current", deleted_at: null, file_type: "cover", object_key: "covers/x.png", public_url: "https://cdn/cover.png" }] };
      if (sql.includes("INSERT INTO pindou_works")) return { rows: [{ id: "work_inserted", user_id: "usr_current", title: "作品", cover_file_id: "file_cover", width: 32, height: 32, bead_count: 2, color_count: 2, brand: "MARD", status: "completed", created_at: new Date("2026-08-27T01:00:00.000Z"), updated_at: new Date("2026-08-27T01:00:00.000Z"), deleted_at: null }] };
      if (sql.includes("INSERT INTO pindou_work_patterns")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const service = new PostgresWorkService(pool, () => new Date("2026-08-27T01:00:00.000Z"));
  const result = await service.create({ userId: "usr_current", idempotencyKey: "save-1", title: "作品", coverFileId: "file_cover", status: "completed", validatedPattern: validatePersistedPattern(pattern()) });
  assert.equal(result.beadCount, 2);
  assert.equal(result.colorCount, 2);
  assert.ok(calls.some((call) => call.sql === "BEGIN"));
  assert.ok(calls.some((call) => call.sql.includes("INSERT INTO pindou_works")));
  assert.ok(calls.some((call) => call.sql.includes("INSERT INTO pindou_work_patterns")));
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("list query does not load cells and detail query maps the persisted pattern", async () => {
  const listRow = row("work_list");
  const detailRow = row("work_detail");
  let listSql = "";
  let detailSql = "";
  const pool = {
    async query(sql) {
      if (sql.includes("COUNT(*)")) return { rows: [{ total_count: "1" }] };
      if (sql.includes("is_favorite") && !sql.includes("patterns.schema_version")) {
        listSql = sql;
        return { rows: [{ ...listRow, is_favorite: true }] };
      }
      detailSql = sql;
      return { rows: [{ ...detailRow, is_favorite: true }] };
    },
  };
  const service = new PostgresWorkService(pool);
  const list = await service.list({ userId: "usr_current", page: 1, pageSize: 20 });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].isFavorite, true);
  assert.equal(list.items[0].pattern, undefined);
  assert.equal(listSql.includes("cells_json"), false);
  assert.equal(listSql.includes("pindou_work_patterns"), false);
  assert.match(listSql, /favorites\.deleted_at IS NULL/u);
  const detail = await service.get("usr_current", "work_detail");
  assert.equal(detail.pattern.cells.length, 1024);
  assert.equal(detail.pattern.cells[1], 1);
  assert.match(detailSql, /favorites\.deleted_at IS NULL/u);
});

test("update replaces edited pattern and derived summary in one transaction", async () => {
  const calls = [];
  const existing = row("work_edit");
  const edited = pattern();
  edited.cells[0] = -1;
  edited.cells[1] = 0;
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM pindou_works works") && sql.includes("FOR UPDATE")) return { rows: [existing] };
      if (sql.includes("FROM pindou_file_assets")) return { rows: [{ user_id: "usr_current", deleted_at: null, file_type: "cover", public_url: "https://cdn/edited.png" }] };
      if (sql.includes("UPDATE pindou_works")) return { rows: [{ ...existing, title: "编辑后的作品", cover_file_id: "file_edited", cover_url: undefined, bead_count: 1, color_count: 1, updated_at: new Date("2026-08-27T02:00:00.000Z") }] };
      if (sql.includes("UPDATE pindou_work_patterns")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const service = new PostgresWorkService({ async connect() { return client; } }, () => new Date("2026-08-27T02:00:00.000Z"));
  const result = await service.update({
    userId: "usr_current",
    workId: "work_edit",
    title: "编辑后的作品",
    coverFileId: "file_edited",
    status: "completed",
    validatedPattern: validatePersistedPattern(edited),
  });
  assert.equal(result.title, "编辑后的作品");
  assert.equal(result.coverUrl, "https://cdn/edited.png");
  assert.equal(result.beadCount, 1);
  assert.ok(calls.some((call) => call.sql.includes("UPDATE pindou_work_patterns")));
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("update without pattern preserves derived summary without loading the pattern", async () => {
  const calls = [];
  const existing = row("work_title_only");
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FOR UPDATE")) return { rows: [existing] };
      if (sql.includes("UPDATE pindou_works")) return { rows: [{ ...existing, title: "只改标题" }] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const service = new PostgresWorkService({ async connect() { return client; } }, () => new Date("2026-08-27T02:00:00.000Z"));
  const result = await service.update({ userId: "usr_current", workId: "work_title_only", title: "只改标题" });
  assert.equal(result.title, "只改标题");
  assert.equal(result.beadCount, existing.bead_count);
  assert.equal(result.colorCount, existing.color_count);
  assert.equal(calls.some((call) => call.sql.includes("pindou_work_patterns")), false);
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("same idempotency key returns the committed work and rejects a changed request", async () => {
  const workId = createIdempotentWorkId("usr_current", "save-retry");
  let committed = false;
  const insertedRow = row(workId);
  const client = {
    async query(sql) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        if (sql === "COMMIT") committed = true;
        return { rows: [] };
      }
      if (sql.includes("FROM pindou_works works")) return { rows: committed ? [insertedRow] : [] };
      if (sql.includes("FROM pindou_file_assets")) return { rows: [{ user_id: "usr_current", deleted_at: null, file_type: "cover", object_key: "covers/x.png", public_url: "https://cdn/cover.png" }] };
      if (sql.includes("INSERT INTO pindou_works")) return { rows: [insertedRow] };
      if (sql.includes("INSERT INTO pindou_work_patterns")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const service = new PostgresWorkService({ async connect() { return client; } }, () => new Date("2026-08-27T01:00:00.000Z"));
  const input = { userId: "usr_current", idempotencyKey: "save-retry", title: "作品", coverFileId: "file_cover", status: "completed", validatedPattern: validatePersistedPattern(pattern()) };
  const first = await service.create(input);
  const second = await service.create(input);
  assert.equal(first.id, second.id);
  await assert.rejects(() => service.create({ ...input, title: "另一份作品" }), (error) => error.code === "IDEMPOTENCY_CONFLICT");
});

test("128x128 save serializes 16384 integer cells instead of cell objects", async () => {
  let patternParameters;
  const client = {
    async query(sql, parameters) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM pindou_works works")) return { rows: [] };
      if (sql.includes("FROM pindou_file_assets")) return { rows: [{ user_id: "usr_current", deleted_at: null, file_type: "cover", object_key: "covers/x.png", public_url: "https://cdn/cover.png" }] };
      if (sql.includes("INSERT INTO pindou_works")) return { rows: [{ id: "work_large", user_id: "usr_current", title: "大图", cover_file_id: "file_cover", width: 128, height: 128, bead_count: 16_384, color_count: 1, brand: "MARD", status: "completed", created_at: new Date(), updated_at: new Date(), deleted_at: null }] };
      if (sql.includes("INSERT INTO pindou_work_patterns")) { patternParameters = parameters; return { rows: [] }; }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const service = new PostgresWorkService({ async connect() { return client; } });
  const result = await service.create({ userId: "usr_current", idempotencyKey: "large-pattern", title: "大图", coverFileId: "file_cover", status: "completed", validatedPattern: validatePersistedPattern(largePattern()) });
  const cells = JSON.parse(patternParameters[7]);
  assert.equal(result.width, 128);
  assert.equal(result.height, 128);
  assert.equal(cells.length, 16_384);
  assert.equal(cells.every((cell) => Number.isInteger(cell)), true);
  assert.equal(cells.some((cell) => typeof cell === "object"), false);
});

test("detail recovery does not depend on a deleted local temporary image", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pindou-history-test-"));
  const temporaryImage = join(directory, "wx-temp-image.png");
  await writeFile(temporaryImage, Buffer.from("temporary image"));
  await unlink(temporaryImage);
  try {
    const pool = { async query() { return { rows: [row("work_history")] }; } };
    const service = new PostgresWorkService(pool);
    const detail = await service.get("usr_current", "work_history");
    assert.equal(detail.pattern.cells.length, 1024);
    assert.equal(detail.pattern.cells[1], 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("user A cannot read, delete or bind user B resources", async () => {
  const foreignWorkPool = {
    async query(sql) {
      if (sql.includes("patterns.cells_json")) return { rows: [] };
      return { rows: [{ user_id: "usr_b", deleted_at: null }] };
    },
  };
  const service = new PostgresWorkService(foreignWorkPool);
  await assert.rejects(() => service.get("usr_a", "work_b"), (error) => error.code === "FORBIDDEN");
  await assert.rejects(() => service.delete("usr_a", "work_b"), (error) => error.code === "FORBIDDEN");

  const foreignCoverClient = {
    async query(sql) {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM pindou_works works")) return { rows: [] };
      if (sql.includes("FROM pindou_file_assets")) return { rows: [{ user_id: "usr_b", deleted_at: null, file_type: "cover", object_key: "covers/b.png", public_url: "https://cdn/b.png" }] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const bindService = new PostgresWorkService({ async connect() { return foreignCoverClient; } });
  await assert.rejects(() => bindService.create({ userId: "usr_a", idempotencyKey: "bind-b", title: "作品", coverFileId: "file_b", status: "completed", validatedPattern: validatePersistedPattern(pattern()) }), (error) => error.code === "FORBIDDEN");
});
