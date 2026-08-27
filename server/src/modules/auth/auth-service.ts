import type { ServerConfig } from "../../config/env";
import { AppError, invalidArgument } from "../../shared/app-error";
import {
  createEntityId,
  createOpaqueToken,
  hashOpenid,
  hashToken,
} from "../../shared/identity";
import type { AuthRepository } from "./auth-repository";
import type { LoginResult } from "./types";
import type { WeChatLoginClient } from "./wechat-client";

const MAX_CODE_LENGTH = 256;

export interface AuthLoginService {
  login(code: string): Promise<LoginResult>;
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
}
