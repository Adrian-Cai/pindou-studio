const assert = require("node:assert/strict");
const test = require("node:test");
const { AppError } = require("../dist/shared/app-error.js");
const { decryptOpenid, hashOpenid, hashToken } = require("../dist/shared/identity.js");
const { AuthService } = require("../dist/modules/auth/auth-service.js");
const { BearerTokenAuthenticator } = require("../dist/modules/auth/authenticator.js");

class InMemoryAuthRepository {
  constructor() {
    this.usersByIdentity = new Map();
    this.users = new Map();
    this.linkCodes = new Map();
    this.sessions = [];
  }

  async createLogin(input) {
    const identityKey = `${input.provider}:${input.identityHash}`;
    let user = this.usersByIdentity.get(identityKey);
    if (!user) {
      user = {
        id: input.proposedUserId,
        nickname: null,
        avatarUrl: null,
        deletedAt: null,
        wechatIdentityHash: input.provider === "wechat" ? input.identityHash : null,
        qqIdentityHash: input.provider === "qq" ? input.identityHash : null,
        sessionKeyCiphertext: input.provider === "wechat" ? input.sessionKeyCiphertext : null,
      };
      this.usersByIdentity.set(identityKey, user);
      this.users.set(user.id, user);
    }
    this.sessions.push({ ...input, userId: user.id });
    return user;
  }

  async createQqLinkCode(input) {
    const user = this.users.get(input.userId);
    if (!user?.wechatIdentityHash || user.qqIdentityHash) {
      throw new AppError(409, "QQ_LINK_UNAVAILABLE", "该账号无法创建 QQ 绑定码");
    }
    for (const [hash, challenge] of this.linkCodes) {
      if (challenge.userId === input.userId && !challenge.consumedAt) this.linkCodes.delete(hash);
    }
    this.linkCodes.set(input.codeHash, { ...input, consumedAt: null });
  }

  async linkQqAndCreateLogin(input) {
    const challenge = this.linkCodes.get(input.linkCodeHash);
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= input.now) {
      throw new AppError(409, "QQ_LINK_CODE_INVALID", "QQ 绑定码无效或已过期");
    }
    const user = this.users.get(challenge.userId);
    const existing = this.usersByIdentity.get(`qq:${input.identityHash}`);
    if (existing && existing.id !== user.id) {
      throw new AppError(409, "QQ_IDENTITY_CONFLICT", "该 QQ 账号已绑定到其他账号");
    }
    if (!existing) {
      user.qqIdentityHash = input.identityHash;
      this.usersByIdentity.set(`qq:${input.identityHash}`, user);
    }
    challenge.consumedAt = input.now;
    this.sessions.push({ ...input, userId: user.id });
    return user;
  }

  async findSessionByTokenHash(tokenHash) {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session) return null;
    return {
      userId: session.userId,
      provider: session.provider,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt ?? null,
      userDeletedAt: null,
    };
  }

  async revokeSession(tokenHash, now) {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (session) session.revokedAt ??= now;
  }

  async revokeUserSessions(userId, now) {
    for (const session of this.sessions) {
      if (session.userId === userId) session.revokedAt ??= now;
    }
  }

  deleteAccount(provider, identityHash) {
    const user = this.usersByIdentity.get(`${provider}:${identityHash}`);
    if (user) user.deletedAt = new Date();
    this.usersByIdentity.delete(`${provider}:${identityHash}`);
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
    { async exchangeCode() { return { openid: "private-openid", sessionKey: "test-session-key" }; } },
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
  assert.equal(repository.usersByIdentity.size, 1);
  assert.equal(repository.sessions.length, 2);
  assert.equal(repository.sessions[0].identityHash.includes("private-openid"), false);
  assert.equal(repository.sessions[0].identityCiphertext.includes("private-openid"), false);
  assert.equal(decryptOpenid(repository.sessions[0].identityCiphertext, authConfig.openidHashSecret), "private-openid");
  assert.equal(first.expiresAt, "2026-09-25T09:00:00.000Z");
});

test("a deleted WeChat account registers as a fresh user", async () => {
  const repository = new InMemoryAuthRepository();
  const service = new AuthService(
    repository,
    { async exchangeCode() { return { openid: "private-openid", sessionKey: "test-session-key" }; } },
    authConfig,
    () => fixedNow,
  );

  const first = await service.login("wx-code-1");
  repository.deleteAccount("wechat", hashOpenid("private-openid", authConfig.openidHashSecret));
  const second = await service.login("wx-code-2");

  assert.notEqual(first.user.id, second.user.id);
  assert.notEqual(repository.sessions[0].userId, repository.sessions[1].userId);
});

test("QQ login stores a separate identity and never overwrites the WeChat payment key", async () => {
  const repository = new InMemoryAuthRepository();
  const qqClient = { async exchangeCode() { return { openid: "qq-private", sessionKey: "qq-key" }; } };
  const service = new AuthService(
    repository,
    { async exchangeCode() { return { openid: "wx-private", sessionKey: "wx-key" }; } },
    authConfig,
    () => fixedNow,
    qqClient,
  );
  const wechatLogin = await service.login("wx-code");
  const qqLogin = await service.login("qq-code", "qq");

  assert.notEqual(wechatLogin.user.id, qqLogin.user.id);
  assert.equal(qqLogin.provider, "qq");
  assert.equal(repository.usersByIdentity.has(`qq:${hashOpenid("qq-private", authConfig.openidHashSecret)}`), true);
  assert.equal(repository.users.get(wechatLogin.user.id).sessionKeyCiphertext.includes("wx-private"), false);
  assert.equal(repository.sessions[1].sessionKeyCiphertext, null);
});

// 注意：QQ_LINK_CODE_INVALID / QQ_IDENTITY_CONFLICT 两条拒绝分支不在这里断言。
// 这里的 InMemoryAuthRepository 是测试自带的 fake，那两个错误码由 fake 自己抛出，
// 断言它等于在验证测试自身。真实分支已由 auth-repository.test.js 用 SQL 级断言覆盖。
test("QQ identity links to the authenticated WeChat user", async () => {
  const repository = new InMemoryAuthRepository();
  const qqClient = { async exchangeCode() { return { openid: "qq-to-link", sessionKey: "qq-key" }; } };
  const service = new AuthService(
    repository,
    { async exchangeCode(code) { return { openid: code, sessionKey: "wx-key" }; } },
    authConfig,
    () => fixedNow,
    qqClient,
  );
  const existing = await service.login("wx-existing");
  const linkCode = await service.createQqLinkCode(existing.user.id);
  const linked = await service.login("qq-code", "qq", linkCode.code);

  assert.equal(linked.user.id, existing.user.id);
  assert.equal(linked.provider, "qq");
});

test("invalid login code is rejected before calling WeChat", async () => {
  let called = false;
  const service = new AuthService(
    new InMemoryAuthRepository(),
    { async exchangeCode() { called = true; return { openid: "unused", sessionKey: "unused" }; } },
    authConfig,
  );
  await assert.rejects(() => service.login("   "), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT");
    return true;
  });
  assert.equal(called, false);
});

test("invalid QQ link codes are rejected before calling QQ", async () => {
  let called = false;
  const service = new AuthService(
    new InMemoryAuthRepository(),
    { async exchangeCode() { throw new Error("must not call WeChat"); } },
    authConfig,
    () => fixedNow,
    { async exchangeCode() { called = true; throw new Error("must not call QQ"); } },
  );
  await assert.rejects(() => service.login("qq-code", "qq", " "), (error) => {
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
  assert.deepEqual(await authenticator.authenticate(`Bearer ${token}`), { id: "usr_test", provider: "wechat" });
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

test("AuthService hashes session tokens before repository revocation", async () => {
  const received = [];
  const repository = {
    async revokeSession(...args) { received.push(args); },
    async revokeUserSessions() {},
  };
  const service = new AuthService(repository, {}, authConfig, () => fixedNow);
  const token = "opaque_token_12345678901234567890";

  await service.revokeSession(token);

  assert.deepEqual(received, [[hashToken(token), fixedNow]]);
});

test("AuthService forwards user IDs when revoking all sessions", async () => {
  let received;
  const service = new AuthService({
    async revokeSession() {},
    async revokeUserSessions(...args) { received = args; },
  }, {}, authConfig, () => fixedNow);

  await service.revokeUserSessions("usr_test");

  assert.deepEqual(received, ["usr_test", fixedNow]);
});
