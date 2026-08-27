export interface PublicUser {
  readonly id: string;
  readonly nickname: string | null;
  readonly avatarUrl: string | null;
}

export interface LoginResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly user: PublicUser;
}

export interface AuthenticatedUser {
  readonly id: string;
}

export interface UserRecord {
  readonly id: string;
  readonly nickname: string | null;
  readonly avatarUrl: string | null;
  readonly deletedAt: Date | null;
}

export interface SessionRecord {
  readonly userId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly userDeletedAt: Date | null;
}
