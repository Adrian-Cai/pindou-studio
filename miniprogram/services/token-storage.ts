import type { AuthProvider, AuthSession, AuthUser, CurrentUserProfile } from '../models/auth'

const AUTH_STORAGE_KEY = 'pindou-auth-session-v1'
const EXPIRY_SKEW_MS = 30_000

export function loadAuthSession(): AuthSession | null {
  try {
    const value = wx.getStorageSync<unknown>(AUTH_STORAGE_KEY)
    return parseSession(value)
  } catch {
    return null
  }
}

export function saveAuthSession(session: AuthSession): void {
  wx.setStorageSync(AUTH_STORAGE_KEY, session)
}

export function clearAuthSession(): void {
  try {
    wx.removeStorageSync(AUTH_STORAGE_KEY)
  } catch {
    // 本地存储不可用时，内存中的 AuthStore 仍会立即退出登录
  }
}

export function isAuthSessionExpired(session: AuthSession, now = Date.now()): boolean {
  const expiresAt = Date.parse(session.expiresAt)
  return !Number.isFinite(expiresAt) || expiresAt <= now + EXPIRY_SKEW_MS
}

function parseSession(value: unknown): AuthSession | null {
  if (!isRecord(value)) return null
  if (typeof value.token !== 'string' || value.token.length < 16) return null
  if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) return null

  const user = parseUser(value.user)
  if (!user) return null

  const profile = parseProfile(value.profile)
  return {
    token: value.token,
    expiresAt: value.expiresAt,
    provider: value.provider === 'qq' ? 'qq' : 'wechat',
    user,
    ...(profile ? { profile } : {}),
  }
}

function parseUser(value: unknown): AuthUser | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null
  if (value.nickname !== null && typeof value.nickname !== 'string') return null
  // 与 services/auth-service.ts 的 parseUser 保持同一口径：头像要如实读回来。
  // 写死 null 的话，冷启动从 storage 恢复的会话会丢掉已保存的头像。
  const avatarUrl = typeof value.avatarUrl === 'string' && value.avatarUrl ? value.avatarUrl : null
  return {
    id: value.id,
    nickname: value.nickname,
    avatarUrl,
  }
}

function parseProfile(value: unknown): CurrentUserProfile | null {
  if (!isRecord(value)) return null
  const user = parseUser(value.user)
  if (!user || !isRecord(value.user) || typeof value.user.createdAt !== 'string') return null
  if (!isRecord(value.stats) || !isRecord(value.quota)) return null

  const stats = value.stats
  const quota = value.quota
  const linkedProviders: AuthProvider[] = Array.isArray(value.linkedProviders)
    && value.linkedProviders.every((provider) => provider === 'wechat' || provider === 'qq')
    ? [...new Set(value.linkedProviders)] as AuthProvider[]
    : ['wechat']
  const aiGeneration = quota.aiGeneration
  if (
    !isFiniteNumber(stats.workCount)
    || !isFiniteNumber(stats.favoriteCount)
    || !isFiniteNumber(stats.downloadCount)
    || !isFiniteNumber(quota.dailyFree)
    || !isFiniteNumber(quota.usedToday)
    || !isFiniteNumber(quota.purchased)
    || !isFiniteNumber(quota.remaining)
    || typeof quota.resetsAt !== 'string'
    || !isRecord(aiGeneration)
    || !isFiniteNumber(aiGeneration.dailyFree)
    || !isFiniteNumber(aiGeneration.usedToday)
    || !isFiniteNumber(aiGeneration.purchased)
    || !isFiniteNumber(aiGeneration.remaining)
    || typeof aiGeneration.resetsAt !== 'string'
    || !Number.isFinite(Date.parse(aiGeneration.resetsAt))
  ) return null

  return {
    linkedProviders,
    user: { ...user, createdAt: value.user.createdAt },
    stats: {
      workCount: stats.workCount,
      favoriteCount: stats.favoriteCount,
      downloadCount: stats.downloadCount,
    },
    quota: {
      dailyFree: quota.dailyFree,
      usedToday: quota.usedToday,
      purchased: quota.purchased,
      remaining: quota.remaining,
      resetsAt: quota.resetsAt,
      aiGeneration: {
        dailyFree: aiGeneration.dailyFree,
        usedToday: aiGeneration.usedToday,
        purchased: aiGeneration.purchased,
        remaining: aiGeneration.remaining,
        resetsAt: aiGeneration.resetsAt,
      },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
