const assert = require("node:assert/strict");
const test = require("node:test");
const { encryptOpenid } = require("../dist/shared/identity.js");
const { AppError } = require("../dist/shared/app-error.js");
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
        const check = sql.includes("WHERE id = $1") ? [...checks.values()].find((item) => item.id === values[0]) : checks.get(values[0]);
        if (check && check.mediaObjectKey === values[1]) check.mediaObjectKey = null;
        return { rows: [] };
      }
      if (sql.includes("FROM pindou_users")) {
        return { rows: [{ openid_ciphertext: encryptOpenid(OPENID, SECRET) }] };
      }
      if (sql.includes("SELECT media_sha256") && sql.includes("WHERE id = $1")) {
        const check = [...checks.values()].find((item) => item.id === values[0]);
        return {
          rows: check
            && check.userId === values[1]
            && (check.status === "pending" || check.status === "pass")
            && check.mediaSha256
            && check.expiresAt > values[2]
            ? [{ media_sha256: check.mediaSha256 }]
            : [],
        };
      }
      if (sql.includes("INSERT INTO pindou_content_security_checks")) {
        checks.set(values[3] ?? values[0], {
          id: values[0],
          userId: values[1],
          mediaObjectKey: values[7],
          mediaSha256: values[8],
          status: values[4],
          expiresAt: values[10],
        });
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
      const objectKey = `content-security/security_${String(sequence).padStart(32, "0")}.png`;
      return {
        objectKey,
        publicUrl: `https://api.example.com/api/content-security/media/${sequence}.png`,
        contentType: "image/png",
      };
    },
    async read() { return null; },
    async remove(objectKey) { removed.push(objectKey); },
  };
  return { pool, storage, checks, queries, removed };
}

function createClient({ imageResult = { safe: true, suggest: "pass", label: null, traceId: null }, submitMediaError = null } = {}) {
  const calls = [];
  return {
    calls,
    async checkText(input) { calls.push({ type: "text", input }); return { safe: true, suggest: "pass", label: null, traceId: null }; },
    async submitMedia(input) {
      calls.push({ type: "async", input });
      if (submitMediaError) throw submitMediaError;
      return { traceId: "trace-media" };
    },
    async checkImage(buffer, filename, contentType) {
      calls.push({ type: "sync", buffer, filename, contentType });
      return imageResult;
    },
  };
}

function createService(state, client, now = () => NOW, asyncMediaCheckEnabled = true) {
  return new PostgresContentSecurityService(
    state.pool,
    client,
    state.storage,
    "wx-test",
    "message-token",
    SECRET,
    now,
    asyncMediaCheckEnabled,
  );
}

test("high-confidence risky work titles are blocked before the provider check", async () => {
  const state = createState();
  const client = createClient();
  const service = createService(state, client);

  for (const title of ["色情", "贩卖毒品"]) {
    await assert.rejects(
      () => service.checkText(USER_ID, title),
      (error) => error.code === "CONTENT_RISKY",
    );
  }
  assert.equal(client.calls.length, 0);
  assert.equal(state.checks.size, 2);
  assert.ok([...state.checks.values()].every((check) => check.status === "risky"));
});

test("release media check applies the synchronous gate before submitting async evidence", async () => {
  const state = createState();
  const client = createClient();
  const service = createService(state, client);

  const result = await service.checkMedia(USER_ID, { buffer: PNG, filename: "source.png", contentType: "image/png" });

  assert.equal(result.safe, true);
  assert.equal(result.traceId, "trace-media");
  assert.deepEqual(client.calls.map((call) => call.type), ["sync", "async"]);
  assert.deepEqual(client.calls[1].input, {
    openid: OPENID,
    mediaUrl: "https://api.example.com/api/content-security/media/1.png",
    scene: 2,
  });
  assert.deepEqual(state.removed, []);
});

test("risky synchronous media is rejected and cleaned with or without async review", async () => {
  for (const asyncMediaCheckEnabled of [true, false]) {
    const state = createState();
    const client = createClient({ imageResult: { safe: false, suggest: "risky", label: 20002, traceId: null } });
    const service = createService(state, client, () => NOW, asyncMediaCheckEnabled);

    await assert.rejects(
      service.checkMedia(USER_ID, { buffer: PNG, filename: "source.png", contentType: "image/png" }),
      (error) => error.code === "CONTENT_RISKY",
    );
    assert.equal(state.removed.length, 1);
    assert.equal(state.checks.get([...state.checks.keys()][0]).status, "risky");
    assert.deepEqual(client.calls.map((call) => call.type), ["sync"]);
  }
});

test("develop media check skips async evidence and cleans passed media", async () => {
  const state = createState();
  const client = createClient();
  const service = createService(state, client, () => NOW, false);

  const result = await service.checkMedia(USER_ID, { buffer: PNG, filename: "source.png", contentType: "image/png" });

  assert.equal(result.safe, true);
  assert.equal(result.traceId, null);
  assert.deepEqual(client.calls.map((call) => call.type), ["sync"]);
  assert.deepEqual(state.removed, ["content-security/security_00000000000000000000000000000001.png"]);
  assert.equal([...state.checks.values()][0].status, "pass");
  assert.equal([...state.checks.values()][0].mediaObjectKey, null);
});

test("passed media check can be reused only by its owner with identical bytes", async () => {
  const state = createState();
  const service = createService(state, createClient());
  const result = await service.checkMedia(USER_ID, { buffer: PNG, filename: "source.png", contentType: "image/png" });
  await service.handleCallback({ appid: "wx-test", Event: "wxa_media_check", trace_id: "trace-media", errcode: 0, result: { suggest: "pass", label: 100 } });

  await service.assertMediaCheck(USER_ID, result.checkId, PNG);
  await assert.rejects(
    service.assertMediaCheck("usr_other", result.checkId, PNG),
    (error) => error.code === "CONTENT_SECURITY_CHECK_INVALID",
  );
  await assert.rejects(
    service.assertMediaCheck(USER_ID, result.checkId, Buffer.from("different")),
    (error) => error.code === "CONTENT_SECURITY_CHECK_INVALID",
  );
});

test("async submission failure returns a security error and cleans media", async () => {
  const state = createState();
  const client = createClient({ submitMediaError: new AppError(503, "WECHAT_CONTENT_SECURITY_UNAVAILABLE", "微信图片审核服务暂时不可用") });
  const service = createService(state, client);

  await assert.rejects(
    service.checkMedia(USER_ID, { buffer: PNG, filename: "source.png", contentType: "image/png" }),
    (error) => error.code === "WECHAT_CONTENT_SECURITY_UNAVAILABLE",
  );
  assert.deepEqual(client.calls.map((call) => call.type), ["sync", "async"]);
  assert.equal(state.removed.length, 1);
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
