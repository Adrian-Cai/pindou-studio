import type { AuthSession, AuthUser, CurrentUserProfile } from '../models/auth'

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
    // 本地存储不可用时，内存中的 AuthStore 仍会立即退出登录。
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
    user,
    ...(profile ? { profile } : {}),
  }
}

function parseUser(value: unknown): AuthUser | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null
  if (value.nickname !== null && typeof value.nickname !== 'string') return null
  if (value.avatarUrl !== null && typeof value.avatarUrl !== 'string') return null
  return {
    id: value.id,
    nickname: value.nickname,
    avatarUrl: value.avatarUrl,
  }
}

function parseProfile(value: unknown): CurrentUserProfile | null {
  if (!isRecord(value)) return null
  const user = parseUser(value.user)
  if (!user || !isRecord(value.user) || typeof value.user.createdAt !== 'string') return null
  if (!isRecord(value.stats) || !isRecord(value.quota)) return null

  const stats = value.stats
  const quota = value.quota
  if (
    !isFiniteNumber(stats.workCount)
    || !isFiniteNumber(stats.favoriteCount)
    || !isFiniteNumber(stats.downloadCount)
    || !isFiniteNumber(quota.dailyFree)
    || !isFiniteNumber(quota.usedToday)
    || !isFiniteNumber(quota.purchased)
    || !isFiniteNumber(quota.remaining)
    || typeof quota.resetsAt !== 'string'
  ) return null

  return {
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
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
