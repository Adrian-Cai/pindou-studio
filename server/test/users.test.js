const assert = require("node:assert/strict");
const test = require("node:test");
const { PostgresUserProfileService } = require("../dist/modules/users/user-profile-service.js");

test("current user response supports nullable profile and summarizes owned data", async () => {
  const calls = [];
  const pool = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes("FROM pindou_users users")) {
        return { rows: [{
          id: "usr_test",
          nickname: null,
          avatar_url: null,
          created_at: new Date("2026-08-20T01:02:03.000Z"),
          work_count: "5",
          favorite_count: "2",
          download_count: "3",
        }] };
      }
      return { rows: [parameters[1] === "ai_generation"
        ? { daily_free: "3", used_today: "2", daily_remaining: "1", purchased: "8" }
        : { daily_free: "3", used_today: "1", daily_remaining: "2", purchased: "2" }] };
    },
  };
  const service = new PostgresUserProfileService(
    pool,
    { dailyStandardDownloads: 3, dailyAiGenerations: 3 },
    () => new Date("2026-08-26T09:00:00.000Z"),
  );

  const result = await service.getCurrentUser("usr_test");
  assert.deepEqual(result.user, {
    id: "usr_test",
    nickname: null,
    avatarUrl: null,
    createdAt: "2026-08-20T01:02:03.000Z",
  });
  assert.deepEqual(result.stats, { workCount: 5, favoriteCount: 2, downloadCount: 3 });
  assert.deepEqual(result.quota, {
    dailyFree: 3,
    usedToday: 1,
    purchased: 2,
    remaining: 4,
    resetsAt: "2026-08-27T00:00:00+08:00",
    aiGeneration: {
      dailyFree: 3,
      usedToday: 2,
      purchased: 8,
      remaining: 9,
      resetsAt: "2026-08-27T00:00:00+08:00",
    },
  });
  assert.deepEqual(calls[0].parameters, ["usr_test"]);
  assert.deepEqual(calls[1].parameters, ["usr_test", "standard_download", "2026-08-26", 3]);
  assert.match(calls[0].sql, /favorites\.deleted_at IS NULL/u);
  assert.match(calls[0].sql, /works\.deleted_at IS NULL/u);
});

test("missing current user is unauthorized", async () => {
  const pool = {
    async query(sql) {
      return sql.includes("FROM pindou_users users")
        ? { rows: [] }
        : { rows: [{ used_today: "0", purchased: "0", ai_used_today: "0", ai_purchased: "0" }] };
    },
  };
  const service = new PostgresUserProfileService(pool, { dailyStandardDownloads: 3, dailyAiGenerations: 3 });
  await assert.rejects(() => service.getCurrentUser("usr_missing"), (error) => {
    assert.equal(error.code, "UNAUTHORIZED");
    return true;
  });
});

test("profile updates derive ownership from the authenticated user id", async () => {
  const calls = [];
  const pool = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes("previous_avatar_url")) {
        return { rows: [{
          id: "usr_test",
          nickname: "拼豆玩家",
          avatar_url: "/api/media/avatars/avatar_new.png",
          previous_avatar_url: "/api/media/avatars/avatar_old.jpg",
          created_at: new Date("2026-08-20T01:02:03.000Z"),
        }] };
      }
      return { rows: [{
        id: "usr_test",
        nickname: "拼豆玩家",
        avatar_url: null,
        created_at: new Date("2026-08-20T01:02:03.000Z"),
      }] };
    },
  };
  const now = new Date("2026-08-26T09:00:00.000Z");
  const service = new PostgresUserProfileService(
    pool,
    { dailyStandardDownloads: 3, dailyAiGenerations: 3 },
    () => now,
  );

  const nicknameUser = await service.updateNickname("usr_test", "拼豆玩家");
  assert.equal(nicknameUser.nickname, "拼豆玩家");
  assert.deepEqual(calls[0].parameters, ["usr_test", "拼豆玩家", now]);

  const avatar = await service.updateAvatar(
    "usr_test",
    "/api/media/avatars/avatar_new.png",
  );
  assert.doesNotMatch(calls[1].sql, /SET nickname/u);
  assert.equal(avatar.user.nickname, "拼豆玩家");
  assert.equal(avatar.previousAvatarUrl, "/api/media/avatars/avatar_old.jpg");
  assert.deepEqual(calls[1].parameters, [
    "usr_test",
    "/api/media/avatars/avatar_new.png",
    now,
  ]);
});
