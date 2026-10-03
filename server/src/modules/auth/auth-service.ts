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
import type { LoginResult } from "./types";
import type { WeChatLoginClient } from "./wechat-client";

const MAX_CODE_LENGTH = 256;

export interface AuthLoginService {
  login(code: string): Promise<LoginResult>;
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
  ) {}

  public async login(rawCode: string): Promise<LoginResult> {
    const code = rawCode.trim();
    if (!code || code.length > MAX_CODE_LENGTH) {
      throw invalidArgument("code 必须是有效的微信登录凭证");
    }

    const wechatSession = await this.wechat.exchangeCode(code);
    const currentTime = this.now();
    const expiresAt = new Date(
      currentTime.getTime() + this.config.tokenTtlDays * 24 * 60 * 60 * 1_000,
    );
    const token = createOpaqueToken();
    const user = await this.repository.createLogin({
      openidHash: hashOpenid(wechatSession.openid, this.config.openidHashSecret),
      openidCiphertext: encryptOpenid(wechatSession.openid, this.config.openidHashSecret),
      // 每次登录都刷新 session_key：它有时效且是虚拟支付 signature 的签名密钥，
      // 留旧值会让用户在下次支付时报 -15007。为 null 表示本次未取到，支付时再引导重登。
      sessionKeyCiphertext: encryptSessionKey(
        wechatSession.sessionKey,
        this.config.openidHashSecret,
      ),
      proposedUserId: createEntityId("usr"),
      sessionId: createEntityId("ses"),
      tokenHash: hashToken(token),
      now: currentTime,
      expiresAt,
    });
    if (user.deletedAt) throw new AppError(403, "ACCOUNT_DISABLED", "账号不可用");

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl },
    };
  }

  /** 接受 token 原文并在服务端计算哈希后吊销。 */
  public async revokeSession(token: string): Promise<void> {
    await this.repository.revokeSession(hashToken(token), this.now());
  }

  public async revokeUserSessions(userId: string): Promise<void> {
    await this.repository.revokeUserSessions(userId, this.now());
  }
}
