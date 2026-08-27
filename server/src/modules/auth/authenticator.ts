import { AppError, unauthorized } from "../../shared/app-error";
import { hashToken } from "../../shared/identity";
import type { AuthRepository } from "./auth-repository";
import type { AuthenticatedUser } from "./types";

export interface RequestAuthenticator {
  authenticate(authorization: string | undefined): Promise<AuthenticatedUser>;
}

export class BearerTokenAuthenticator implements RequestAuthenticator {
  public constructor(
    private readonly repository: AuthRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async authenticate(authorization: string | undefined): Promise<AuthenticatedUser> {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,512})$/);
    if (!match?.[1]) throw unauthorized();

    const session = await this.repository.findSessionByTokenHash(hashToken(match[1]));
    if (!session || session.revokedAt || session.userDeletedAt) throw unauthorized("登录状态已失效");
    if (session.expiresAt.getTime() <= this.now().getTime()) {
      throw new AppError(401, "TOKEN_EXPIRED", "登录状态已过期，请重新登录");
    }
    return { id: session.userId };
  }
}
