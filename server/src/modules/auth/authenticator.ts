import { AppError, unauthorized } from "../../shared/app-error";
import { hashToken } from "../../shared/identity";
import type { AuthRepository } from "./auth-repository";
import type { AuthenticatedUser } from "./types";

export interface RequestAuthenticator {
  authenticate(authorization: string | undefined): Promise<AuthenticatedUser>;
}

/** 从 Authorization 头提取符合系统格式的 Bearer token。 */
export function parseBearerToken(authorization: string | undefined): string | null {
  return authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,512})$/)?.[1] ?? null;
}

export class BearerTokenAuthenticator implements RequestAuthenticator {
  public constructor(
    private readonly repository: AuthRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async authenticate(authorization: string | undefined): Promise<AuthenticatedUser> {
    const token = parseBearerToken(authorization);
    if (!token) throw unauthorized();

    const session = await this.repository.findSessionByTokenHash(hashToken(token));
    if (!session || session.revokedAt || session.userDeletedAt) throw unauthorized("登录状态已失效");
    if (session.expiresAt.getTime() <= this.now().getTime()) {
      throw new AppError(401, "TOKEN_EXPIRED", "登录状态已过期，请重新登录");
    }
    return { id: session.userId, provider: session.provider ?? "wechat" };
  }
}
