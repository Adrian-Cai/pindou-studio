export interface PublicUser {
  readonly id: string;
  readonly nickname: string | null;
  readonly avatarUrl: string | null;
}

export interface LoginResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly provider: AuthProvider;
  readonly user: PublicUser;
}

export type AuthProvider = "wechat" | "qq";

export interface AuthenticatedUser {
  readonly id: string;
  readonly provider: AuthProvider;
}

export interface UserRecord {
  readonly id: string;
  readonly nickname: string | null;
  readonly avatarUrl: string | null;
  readonly deletedAt: Date | null;
}

export interface SessionRecord {
  readonly userId: string;
  readonly provider: AuthProvider;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly userDeletedAt: Date | null;
}
