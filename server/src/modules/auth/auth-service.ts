import type { ServerConfig } from "../../config/env";
import { AppError, invalidArgument } from "../../shared/app-error";
import {
  createEntityId,
  createOpaqueToken,
  encryptOpenid,
  encryptSessionKey,
  hashOpenid,
  hashToken,
} from "../../shared/identity";
import type { AuthRepository } from "./auth-repository";
import type { AuthProvider, LoginResult } from "./types";
import type { WeChatLoginClient } from "./wechat-client";
import type { QqLoginClient } from "./qq-client";

const MAX_CODE_LENGTH = 256;

export interface AuthLoginService {
  login(code: string, provider?: AuthProvider, linkCode?: string): Promise<LoginResult>;
  createQqLinkCode(userId: string): Promise<{ code: string; expiresAt: string }>;
  /** 接受 token 原文并由服务端完成哈希后吊销。 */
  revokeSession(token: string): Promise<void>;
  /** 吊销指定用户的全部会话。 */
  revokeUserSessions(userId: string): Promise<void>;
}

export class AuthService implements AuthLoginService {
  public constructor(
    private readonly repository: AuthRepository,
    private readonly wechat: WeChatLoginClient,
    private readonly config: ServerConfig["auth"],
    private readonly now: () => Date = () => new Date(),
    private readonly qq?: QqLoginClient,
  ) {}

  public async login(
    rawCode: string,
    provider: AuthProvider = "wechat",
    rawLinkCode?: string,
  ): Promise<LoginResult> {
    const code = rawCode.trim();
    if (!code || code.length > MAX_CODE_LENGTH) {
      throw invalidArgument("code 必须是有效的小程序登录凭证");
    }

    if (provider === "qq" && !this.qq) {
      throw new AppError(503, "QQ_LOGIN_NOT_CONFIGURED", "QQ 登录服务尚未配置");
    }
    if (provider === "wechat" && rawLinkCode !== undefined) {
      throw invalidArgument("微信登录不接受 QQ 绑定码");
    }
    const linkCode = rawLinkCode?.trim();
    if (linkCode !== undefined && (!linkCode || linkCode.length > 128)) {
      throw invalidArgument("QQ 绑定码无效");
    }
    const identity = provider === "qq"
      ? await this.qq!.exchangeCode(code)
      : await this.wechat.exchangeCode(code);
    const currentTime = this.now();
    const expiresAt = new Date(
      currentTime.getTime() + this.config.tokenTtlDays * 24 * 60 * 60 * 1_000,
    );
    const token = createOpaqueToken();
    const identityHash = hashOpenid(identity.openid, this.config.openidHashSecret);
    const identityCiphertext = encryptOpenid(identity.openid, this.config.openidHashSecret);
    const loginInput = {
      provider,
      identityHash,
      identityCiphertext,
      // QQ 暂不支付。保留用户之前的微信 session_key，避免 QQ 登录覆盖微信支付凭据。
      sessionKeyCiphertext: provider === "wechat"
        ? encryptSessionKey(identity.sessionKey, this.config.openidHashSecret)
        : null,
      proposedUserId: createEntityId("usr"),
      sessionId: createEntityId("ses"),
      tokenHash: hashToken(token),
      now: currentTime,
      expiresAt,
    };
    const user = provider === "qq" && linkCode
      ? await this.repository.linkQqAndCreateLogin({
          ...loginInput,
          provider: "qq",
          linkCodeHash: hashToken(linkCode),
        })
      : await this.repository.createLogin(loginInput);
    if (user.deletedAt) throw new AppError(403, "ACCOUNT_DISABLED", "账号不可用");

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      provider,
      user: { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl },
    };
  }

  public async createQqLinkCode(userId: string): Promise<{ code: string; expiresAt: string }> {
    const code = createOpaqueToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1_000);
    await this.repository.createQqLinkCode({
      userId,
      codeHash: hashToken(code),
      now,
      expiresAt,
    });
    return { code, expiresAt: expiresAt.toISOString() };
  }

  /** 接受 token 原文并在服务端计算哈希后吊销。 */
  public async revokeSession(token: string): Promise<void> {
    await this.repository.revokeSession(hashToken(token), this.now());
  }

  public async revokeUserSessions(userId: string): Promise<void> {
    await this.repository.revokeUserSessions(userId, this.now());
  }
}
