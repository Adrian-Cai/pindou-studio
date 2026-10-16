const assert = require("node:assert/strict");
const test = require("node:test");
const { PostgresAuthRepository } = require("../dist/modules/auth/auth-repository.js");

const loginInput = {
  provider: "qq",
  identityHash: "qq-identity-hash",
  identityCiphertext: "encrypted-qq-identity",
  sessionKeyCiphertext: null,
  proposedUserId: "usr_unused",
  sessionId: "ses_qq",
  tokenHash: "token-hash",
  now: new Date("2026-10-16T00:00:00.000Z"),
  expiresAt: new Date("2026-11-15T00:00:00.000Z"),
  linkCodeHash: "link-code-hash",
};

function makeClient({ existingQqUser } = {}) {
  const statements = [];
  const client = {
    async query(sql, parameters = []) {
      statements.push({ sql, parameters });
      if (sql.startsWith("SELECT user_id")) return { rows: [{ user_id: "usr_wechat" }] };
      if (sql.startsWith("SELECT id, nickname")) return { rows: [{
        id: "usr_wechat", nickname: "豆友", avatar_url: null, deleted_at: null, qq_openid_hash: null,
      }] };
      if (sql.startsWith("SELECT id FROM pindou_users WHERE qq_openid_hash")) {
        return { rows: existingQqUser ? [{ id: existingQqUser }] : [] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { client, statements };
}

test("QQ link updates the WeChat user, creates a QQ session and consumes the code in one transaction", async () => {
  const { client, statements } = makeClient();
  const repository = new PostgresAuthRepository({ async connect() { return client; } });

  const user = await repository.linkQqAndCreateLogin(loginInput);

  assert.deepEqual(user, { id: "usr_wechat", nickname: "豆友", avatarUrl: null, deletedAt: null });
  assert.equal(statements[0].sql, "BEGIN");
  assert.equal(statements.some(({ sql }) => sql.includes("SET qq_openid_hash = $2")), true);
  const session = statements.find(({ sql }) => sql.includes("INSERT INTO pindou_auth_sessions"));
  assert.equal(session.parameters[1], "usr_wechat");
  assert.equal(session.parameters[3], "qq");
  const consumed = statements.find(({ sql }) => sql.includes("UPDATE pindou_qq_link_challenges"));
  assert.deepEqual(consumed.parameters, ["link-code-hash", loginInput.now]);
  assert.equal(statements.at(-1).sql, "COMMIT");
});

test("QQ identity conflict aborts linking without creating a session or consuming the code", async () => {
  const { client, statements } = makeClient({ existingQqUser: "usr_elsewhere" });
  const repository = new PostgresAuthRepository({ async connect() { return client; } });

  await assert.rejects(() => repository.linkQqAndCreateLogin(loginInput), (error) => {
    assert.equal(error.code, "QQ_IDENTITY_CONFLICT");
    return true;
  });
  assert.equal(statements.some(({ sql }) => sql.includes("INSERT INTO pindou_auth_sessions")), false);
  assert.equal(statements.some(({ sql }) => sql.includes("UPDATE pindou_qq_link_challenges")), false);
  assert.equal(statements.at(-1).sql, "ROLLBACK");
});
