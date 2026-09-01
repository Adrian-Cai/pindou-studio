const assert = require("node:assert/strict");
const test = require("node:test");
const { AppError } = require("../dist/shared/app-error.js");
const { decryptOpenid, hashToken } = require("../dist/shared/identity.js");
const { AuthService } = require("../dist/modules/auth/auth-service.js");
const { BearerTokenAuthenticator } = require("../dist/modules/auth/authenticator.js");

class InMemoryAuthRepository {
  constructor() {
    this.usersByOpenidHash = new Map();
    this.sessions = [];
  }

  async createLogin(input) {
    let user = this.usersByOpenidHash.get(input.openidHash);
    if (!user) {
      user = {
        id: input.proposedUserId,
        nickname: null,
        avatarUrl: null,
        deletedAt: null,
      };
      this.usersByOpenidHash.set(input.openidHash, user);
    }
    this.sessions.push({ ...input, userId: user.id });
    return user;
  }

  async findSessionByTokenHash(tokenHash) {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session) return null;
    return {
      userId: session.userId,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt ?? null,
      userDeletedAt: null,
    };
  }
}

const authConfig = {
  openidHashSecret: "test_openid_hash_secret_32_characters_long",
  tokenTtlDays: 30,
};
const fixedNow = new Date("2026-08-26T09:00:00.000Z");

test("same WeChat openid reuses the user and creates independent opaque sessions", async () => {
  const repository = new InMemoryAuthRepository();
  const service = new AuthService(
    repository,
    { async exchangeCode() { return { openid: "private-openid" }; } },
    authConfig,
    () => fixedNow,
  );

  const first = await service.login("wx-code-1");
  const second = await service.login("wx-code-2");

  assert.equal(first.user.id, second.user.id);
  assert.equal(first.user.nickname, null);
  assert.equal(first.user.avatarUrl, null);
  assert.notEqual(first.token, second.token);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(repository.usersByOpenidHash.size, 1);
  assert.equal(repository.sessions.length, 2);
  assert.equal(repository.sessions[0].openidHash.includes("private-openid"), false);
  assert.equal(repository.sessions[0].openidCiphertext.includes("private-openid"), false);
  assert.equal(decryptOpenid(repository.sessions[0].openidCiphertext, authConfig.openidHashSecret), "private-openid");
  assert.equal(first.expiresAt, "2026-09-25T09:00:00.000Z");
});

test("invalid login code is rejected before calling WeChat", async () => {
  let called = false;
  const service = new AuthService(
    new InMemoryAuthRepository(),
    { async exchangeCode() { called = true; return { openid: "unused" }; } },
    authConfig,
  );
  await assert.rejects(() => service.login("   "), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT");
    return true;
  });
  assert.equal(called, false);
});

test("Bearer token authentication accepts a valid session", async () => {
  const token = "valid_opaque_token_12345678901234567890";
  const repository = {
    async findSessionByTokenHash(receivedHash) {
      assert.equal(receivedHash, hashToken(token));
      return {
        userId: "usr_test",
        expiresAt: new Date("2026-08-27T09:00:00.000Z"),
        revokedAt: null,
        userDeletedAt: null,
      };
    },
  };
  const authenticator = new BearerTokenAuthenticator(repository, () => fixedNow);
  assert.deepEqual(await authenticator.authenticate(`Bearer ${token}`), { id: "usr_test" });
});

test("expired and revoked sessions cannot authenticate", async (t) => {
  await t.test("expired", async () => {
    const authenticator = new BearerTokenAuthenticator(
      { async findSessionByTokenHash() { return {
        userId: "usr_test",
        expiresAt: fixedNow,
        revokedAt: null,
        userDeletedAt: null,
      }; } },
      () => fixedNow,
    );
    await assert.rejects(() => authenticator.authenticate("Bearer valid_token_12345678901234567890"), (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "TOKEN_EXPIRED");
      return true;
    });
  });

  await t.test("revoked", async () => {
    const authenticator = new BearerTokenAuthenticator(
      { async findSessionByTokenHash() { return {
        userId: "usr_test",
        expiresAt: new Date("2026-08-27T09:00:00.000Z"),
        revokedAt: fixedNow,
        userDeletedAt: null,
      }; } },
      () => fixedNow,
    );
    await assert.rejects(() => authenticator.authenticate("Bearer valid_token_12345678901234567890"), (error) => {
      assert.equal(error.code, "UNAUTHORIZED");
      return true;
    });
  });
});

test("missing or malformed Bearer token is unauthorized", async () => {
  const authenticator = new BearerTokenAuthenticator({
    async findSessionByTokenHash() { throw new Error("must not query"); },
  });
  await assert.rejects(() => authenticator.authenticate(undefined), (error) => error.code === "UNAUTHORIZED");
  await assert.rejects(() => authenticator.authenticate("Bearer short"), (error) => error.code === "UNAUTHORIZED");
});
