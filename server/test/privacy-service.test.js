const assert = require("node:assert/strict");
const test = require("node:test");
const { PostgresUserProfileService } = require("../dist/modules/users/user-profile-service.js");

const quota = { dailyStandardDownloads: 3, dailyAiGenerations: 3 };

test("privacy updates normalize local-only and cloud-sync as mutually exclusive", async () => {
  const calls = [];
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("FOR UPDATE")) {
        return { rows: [{
          privacy_local_only: true,
          privacy_cloud_sync: false,
          privacy_service_notices: true,
          privacy_personalized_recommendations: false,
          updated_at: new Date("2026-09-01T00:00:00.000Z"),
        }] };
      }
      return { rows: [{
        privacy_local_only: false,
        privacy_cloud_sync: true,
        privacy_service_notices: true,
        privacy_personalized_recommendations: false,
        updated_at: new Date("2026-09-06T00:00:00.000Z"),
      }] };
    },
    release() {},
  };
  const service = new PostgresUserProfileService(
    { async connect() { return client; } },
    quota,
    () => new Date("2026-09-06T00:00:00.000Z"),
  );

  const result = await service.updatePrivacyPreferences("usr_test", { cloudSync: true });
  assert.equal(result.localOnly, false);
  assert.equal(result.cloudSync, true);
  assert.deepEqual(calls[2].parameters, [
    "usr_test",
    false,
    true,
    true,
    false,
    new Date("2026-09-06T00:00:00.000Z"),
  ]);
});

test("account deletion marks assets and physically removes avatar, covers and AI files after commit", async () => {
  const statements = [];
  const cleanup = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes("WITH previous AS")) {
        return { rowCount: 1, rows: [{ id: "usr_test", previous_avatar_url: "/api/media/avatars/avatar_old.png" }] };
      }
      if (sql.includes("UPDATE pindou_file_assets")) {
        return { rowCount: 4, rows: [
          { file_type: "cover", object_key: "covers/cover_old.png" },
          { file_type: "ai_input", object_key: "ai/ai_input_old.png" },
          { file_type: "ai_output", object_key: "ai/ai_output_old.png" },
        ] };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("UPDATE pindou_")) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const service = new PostgresUserProfileService(
    { async connect() { return client; } },
    quota,
    () => new Date("2026-09-06T00:00:00.000Z"),
    {
      avatars: { async remove(path) { cleanup.push(["avatar", path]); } },
      covers: { async remove(path) { cleanup.push(["cover", path]); } },
      aiFiles: { async remove(path) { cleanup.push(["ai", path]); } },
    },
  );

  await service.deleteAccount("usr_test");
  assert.equal(statements[0], "BEGIN");
  const deleteUserStatement = statements.find((sql) => sql.includes("WITH previous AS"));
  assert.match(deleteUserStatement, /UPDATE pindou_users/);
  assert.match(deleteUserStatement, /openid_hash = NULL/);
  assert.match(deleteUserStatement, /openid_ciphertext = NULL/);
  assert.match(statements.find((sql) => sql.includes("UPDATE pindou_auth_sessions")), /UPDATE pindou_auth_sessions/);
  assert.match(statements.find((sql) => sql.includes("UPDATE pindou_works")), /UPDATE pindou_works/);
  assert.match(statements.find((sql) => sql.includes("DELETE FROM pindou_favorites")), /DELETE FROM pindou_favorites/);
  assert.match(statements.find((sql) => sql.includes("UPDATE pindou_file_assets")), /UPDATE pindou_file_assets/);
  assert.equal(statements.at(-1), "COMMIT");
  assert.equal(statements.some((sql) => /pindou_orders|pindou_quota_transactions/.test(sql)), false);
  assert.deepEqual(cleanup, [
    ["avatar", "/api/media/avatars/avatar_old.png"],
    ["cover", "covers/cover_old.png"],
    ["ai", "ai/ai_input_old.png"],
    ["ai", "ai/ai_output_old.png"],
  ]);
});
