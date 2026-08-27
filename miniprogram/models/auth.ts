export interface AuthUser {
  id: string
  nickname: string | null
  avatarUrl: string | null
}

export interface CurrentUserProfile {
  user: AuthUser & {
    createdAt: string
  }
  stats: {
    workCount: number
    favoriteCount: number
    downloadCount: number
  }
  quota: {
    dailyFree: number
    usedToday: number
    purchased: number
    remaining: number
    resetsAt: string
  }
}

export interface AuthSession {
  token: string
  expiresAt: string
  user: AuthUser
  profile?: CurrentUserProfile
}
