export interface AuthUser {
  id: string
  nickname: string | null
  avatarUrl: string | null
}

export type AuthProvider = "wechat" | "qq"

/**
 * 当前登录用户的完整资料。
 *
 * 不变式：**`quota` 与 `quota.aiGeneration` 一定存在且字段齐全**。
 * 两个构造入口都做了完整校验 —— 网络侧 `services/auth-service.ts` 的
 * `parseCurrentUserResponse`（缺字段直接 `throw invalidResponse()`），
 * 持久化侧 `services/token-storage.ts` 的 `parseProfile`（缺字段返回 null）。
 * 因此读取侧只需 `profile?.quota.remaining`，不必再对 `quota` 加可选链；
 * 谁要是加，说明上游解析器漏了校验，该修的是解析器而不是这里。
 */
export interface CurrentUserProfile {
  linkedProviders: AuthProvider[]
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
    aiGeneration: {
      dailyFree: number
      usedToday: number
      purchased: number
      remaining: number
      resetsAt: string
    }
  }
}

export interface AuthSession {
  token: string
  expiresAt: string
  provider: AuthProvider
  user: AuthUser
  profile?: CurrentUserProfile
}
