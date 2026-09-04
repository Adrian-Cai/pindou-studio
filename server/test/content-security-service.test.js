const assert = require("node:assert/strict");
const test = require("node:test");
const { encryptOpenid } = require("../dist/shared/identity.js");
const { PostgresContentSecurityService } = require("../dist/modules/content-security/content-security-service.js");

const SECRET = "content-security-test-secret";
const USER_ID = "usr_security";
const OPENID = "openid-security";
const NOW = new Date("2026-09-03T00:00:00.000Z");
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function createState({ expired = [] } = {}) {
  const checks = new Map();
  const queries = [];
  const removed = [];
  let sequence = 0;
  const pool = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes("UPDATE pindou_content_security_checks") && sql.includes("expires_at <=")) {
        return { rows: expired.map((mediaObjectKey) => ({ media_object_key: mediaObjectKey })) };
      }
      if (sql.includes("SET media_object_key = NULL")) {
        const check = checks.get(values[0]);
        if (check && check.mediaObjectKey === values[1]) check.mediaObjectKey = null;
        return { rows: [] };
      }
      if (sql.includes("FROM pindou_users")) {
        return { rows: [{ openid_ciphertext: encryptOpenid(OPENID, SECRET) }] };
      }
      if (sql.includes("INSERT INTO pindou_content_security_checks")) {
        checks.set(values[3], { mediaObjectKey: values[7], status: values[4] });
        return { rows: [] };
      }
      if (sql.includes("UPDATE pindou_content_security_checks")) {
        const check = checks.get(values[0]);
        if (!check || (check.status !== "pending" && check.status !== "risky") || !check.mediaObjectKey) return { rows: [] };
        if (check.status !== "risky") check.status = values[1];
        return { rows: [{ media_object_key: check.mediaObjectKey }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const storage = {
    async save() {
      sequence += 1;
      return {
        objectKey: `content-security/security_${String(sequence).padStart(32, "0")}.png`,
        publicUrl: `https://api.example.com/api/content-security/media/${sequence}.png`,
        contentType: "image/png",
      };
    },
    async read() { return null; },
    async remove(objectKey) { removed.push(objectKey); },
  };
  return { pool, storage, checks, queries, removed };
}

function createClient({ imageResult = { safe: true, suggest: "pass", label: null, traceId: null } } = {}) {
  const calls = [];
  return {
    calls,
    async checkText(input) { calls.push({ type: "text", input }); return { safe: true, suggest: "pass", label: null, traceId: null }; },
    async submitMedia(input) { calls.push({ type: "async", input }); return { traceId: "trace-media" }; },
    async checkImage(buffer, filename, contentType) {
      calls.push({ type: "sync", buffer, filename, contentType });
      return imageResult;
    },
  };
}

function createService(state, client, now = () => NOW) {
  return new PostgresContentSecurityService(
    state.pool,
    client,
    state.storage,
    "wx-test",
    "message-token",
    SECRET,
    now,
  );
}

test("media check submits async evidence and applies the synchronous gate", async () => {
  const state = createState();
  const client = createClient();
  const service = createService(state, client);

  const result = await service.checkMedia(USER_ID, { buffer: PNG, filename: "source.png", contentType: "image/png" });

  assert.equal(result.safe, true);
  assert.equal(result.traceId, "trace-media");
  assert.deepEqual(client.calls.map((call) => call.type), ["async", "sync"]);
  assert.deepEqual(client.calls[0].input, {
    openid: OPENID,
    mediaUrl: "https://api.example.com/api/content-security/media/1.png",
    scene: 2,
  });
  assert.deepEqual(state.removed, []);
});

test("risky synchronous image result is blocked and media stays for async evidence", async () => {
  const state = createState();
  const client = createClient({ imageResult: { safe: false, suggest: "risky", label: 20002, traceId: null } });
  const service = createService(state, client);

  await assert.rejects(
    service.checkMedia(USER_ID, { buffer: PNG, filename: "source.png", contentType: "image/png" }),
    (error) => error.code === "CONTENT_RISKY" && error.message === "你发布的内容含违规信息，请修改后重试",
  );
  assert.equal(state.removed.length, 0);
  assert.equal(state.checks.get("trace-media").status, "risky");
  await service.handleCallback({ appid: "wx-test", Event: "wxa_media_check", trace_id: "trace-media", errcode: 0, result: { suggest: "pass", label: 100 } });
  assert.equal(state.removed.length, 1);
  assert.equal(state.checks.get("trace-media").status, "risky");
});

test("callback is idempotent, ignores unknown traces, and removes expired media", async () => {
  const state = createState({ expired: ["content-security/expired.png"] });
  const client = createClient();
  const service = createService(state, client);
  await service.checkMedia(USER_ID, { buffer: PNG, filename: "source.png", contentType: "image/png" });

  await service.handleCallback({ appid: "wx-test", Event: "wxa_media_check", trace_id: "trace-media", errcode: 0, result: { suggest: "pass", label: 100 } });
  await service.handleCallback({ appid: "wx-test", Event: "wxa_media_check", trace_id: "trace-media", errcode: 0, result: { suggest: "pass", label: 100 } });
  await service.handleCallback({ appid: "wx-test", Event: "wxa_media_check", trace_id: "unknown", errcode: 0, result: { suggest: "pass" } });

  assert.deepEqual(state.removed, ["content-security/expired.png", "content-security/security_00000000000000000000000000000001.png"]);
  assert.equal(state.checks.get("trace-media").status, "pass");
});

test("callback signature uses the configured token", () => {
  const state = createState();
  const service = createService(state, createClient());
  const crypto = require("node:crypto");
  const signature = crypto.createHash("sha1").update(["message-token", "123", "nonce"].sort().join(""), "utf8").digest("hex");
  assert.equal(service.verifyCallback(signature, "123", "nonce"), true);
  assert.equal(service.verifyCallback("bad", "123", "nonce"), false);
});
