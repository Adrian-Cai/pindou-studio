const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const test = require("node:test");
const { createPool } = require("../dist/db/pool.js");
const { loadLocalEnv, readConfig } = require("../dist/config/env.js");
const { createHttpApplication } = require("../dist/http/app.js");
const { startHttpServer } = require("../dist/http/server.js");
const { PostgresAuthRepository } = require("../dist/modules/auth/auth-repository.js");
const { BearerTokenAuthenticator } = require("../dist/modules/auth/authenticator.js");
const { FileSystemCoverStorage } = require("../dist/modules/files/cover-storage.js");
const { PostgresFileAssetService } = require("../dist/modules/files/file-asset-service.js");
const { PostgresWorkService } = require("../dist/modules/works/work-service.js");
const { hashToken } = require("../dist/shared/identity.js");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";

function pattern(firstCell = 0) {
  return {
    schemaVersion: 1,
    width: 32,
    height: 32,
    settings: { colorLimit: 1, brand: "MARD" },
    palette: [{ code: "C01", color: "#000000" }],
    cells: [firstCell].concat(Array(1023).fill(0)),
  };
}

test("stage 2 real database flow: upload, create, list, detail, update, media read and delete", { skip: !enabled }, async () => {
  loadLocalEnv();
  const config = readConfig();
  const pool = createPool(config.database);
  const suffix = randomBytes(8).toString("hex");
  const userId = `usr_it_${suffix}`;
  const sessionId = `ses_it_${suffix}`;
  const token = randomBytes(32).toString("base64url");
  const storedObjects = [];
  let running;
  let activeCovers;

  try {
    const now = new Date();
    await pool.query(
      `INSERT INTO pindou_users (
         id, openid_hash, openid_ciphertext, nickname, avatar_url, created_at, updated_at, deleted_at
       ) VALUES ($1, $2, NULL, '阶段2联调', NULL, $3, $3, NULL)`,
      [userId, `integration_${suffix}`, now],
    );
    await pool.query(
      `INSERT INTO pindou_auth_sessions (
         id, user_id, token_hash, expires_at, revoked_at, created_at, last_used_at
       ) VALUES ($1, $2, $3, $4, NULL, $5, NULL)`,
      [sessionId, userId, hashToken(token), new Date(now.getTime() + 60 * 60 * 1_000), now],
    );

    const covers = {
      async save(...args) {
        if (!activeCovers) throw new Error("cover storage not ready");
        return activeCovers.save(...args);
      },
      async read(...args) {
        if (!activeCovers) throw new Error("cover storage not ready");
        return activeCovers.read(...args);
      },
      async remove(...args) {
        if (!activeCovers) throw new Error("cover storage not ready");
        return activeCovers.remove(...args);
      },
    };
    running = await startHttpServer(createHttpApplication({
      database: { async check() { return { status: "up", product: "PostgreSQL", version: "integration", schemaStatus: "valid" }; } },
      auth: { async login() { throw new Error("unused"); } },
      authenticator: new BearerTokenAuthenticator(new PostgresAuthRepository(pool)),
      users: { async getCurrentUser() { throw new Error("unused"); } },
      avatars: { async save() { throw new Error("unused"); }, async read() { return null; }, async remove() {} },
      avatarMaximumBytes: config.avatars.maximumBytes,
      covers,
      coverMaximumBytes: config.covers.maximumBytes,
      files: new PostgresFileAssetService(pool, covers),
      works: new PostgresWorkService(pool),
      contentSecurity: { async checkText() { return { safe: true, traceId: null }; } },
    }), config.host, 0);
    const baseUrl = `http://${config.host}:${running.port}`;
    activeCovers = new FileSystemCoverStorage(
      config.covers.storageDirectory,
      `${baseUrl}/api/media/covers`,
    );
    const authorization = { authorization: `Bearer ${token}` };

    const upload = async () => {
      const form = new FormData();
      form.append("file", new Blob([PNG], { type: "image/png" }), "cover.png");
      form.append("type", "cover");
      const response = await fetch(`${baseUrl}/api/files/upload`, { method: "POST", headers: authorization, body: form });
      const body = await response.json();
      assert.equal(response.status, 201, JSON.stringify(body));
      return body.file;
    };

    const firstCover = await upload();
    const createResponse = await fetch(`${baseUrl}/api/works`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json", "Idempotency-Key": `integration-${suffix}` },
      body: JSON.stringify({ title: "联调作品", coverFileId: firstCover.id, status: "completed", pattern: pattern() }),
    });
    const created = await createResponse.json();
    assert.equal(createResponse.status, 201, JSON.stringify(created));
    assert.equal(created.beadCount, 1024);

    const listResponse = await fetch(`${baseUrl}/api/works?page=1&pageSize=20`, { headers: authorization });
    const list = await listResponse.json();
    assert.equal(listResponse.status, 200, JSON.stringify(list));
    assert.equal(list.items.some((item) => item.id === created.id), true);
    assert.equal(list.items.find((item) => item.id === created.id).pattern, undefined);

    const detailResponse = await fetch(`${baseUrl}/api/works/${created.id}`, { headers: authorization });
    const detail = await detailResponse.json();
    assert.equal(detailResponse.status, 200, JSON.stringify(detail));
    assert.equal(detail.pattern.cells.length, 1024);

    const secondCover = await upload();
    const updateResponse = await fetch(`${baseUrl}/api/works/${created.id}`, {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ title: "联调作品已编辑", coverFileId: secondCover.id, pattern: pattern(-1) }),
    });
    const updated = await updateResponse.json();
    assert.equal(updateResponse.status, 200, JSON.stringify(updated));
    assert.equal(updated.title, "联调作品已编辑");
    assert.equal(updated.beadCount, 1023);

    const mediaResponse = await fetch(updated.coverUrl);
    assert.equal(mediaResponse.status, 200);
    assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()), PNG);

    const deleteResponse = await fetch(`${baseUrl}/api/works/${created.id}`, { method: "DELETE", headers: authorization });
    assert.equal(deleteResponse.status, 204);
    const deletedDetail = await fetch(`${baseUrl}/api/works/${created.id}`, { headers: authorization });
    assert.equal(deletedDetail.status, 404);

    const assets = await pool.query("SELECT object_key FROM pindou_file_assets WHERE user_id = $1", [userId]);
    storedObjects.push(...assets.rows.map((row) => row.object_key));
  } finally {
    if (running) await running.close();
    const objects = storedObjects.length > 0
      ? storedObjects
      : (await pool.query("SELECT object_key FROM pindou_file_assets WHERE user_id = $1", [userId])).rows.map((row) => row.object_key);
    await pool.query("DELETE FROM pindou_work_patterns WHERE work_id IN (SELECT id FROM pindou_works WHERE user_id = $1)", [userId]);
    await pool.query("DELETE FROM pindou_works WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM pindou_file_assets WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM pindou_auth_sessions WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM pindou_users WHERE id = $1", [userId]);
    const covers = new FileSystemCoverStorage(config.covers.storageDirectory, config.covers.publicBaseUrl);
    await Promise.all(objects.map((objectKey) => covers.remove(objectKey)));
    await pool.end();
  }
});
