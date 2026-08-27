import type { AuthSession, AuthUser, CurrentUserProfile } from '../models/auth'
import { buildApiUrl } from '../config/api'
import { ApiError, apiRequest, apiUploadFile } from './http-client'

export async function loginWithWechat(): Promise<AuthSession> {
  const code = await getWechatLoginCode()
  const response = await apiRequest<unknown>({
    path: '/api/auth/login',
    method: 'POST',
    data: { code },
  })
  return parseLoginResponse(response)
}

export async function fetchCurrentUser(token: string): Promise<CurrentUserProfile> {
  const response = await apiRequest<unknown>({
    path: '/api/users/me',
    token,
  })
  return parseCurrentUserResponse(response)
}

export async function updateNickname(token: string, nickname: string): Promise<AuthUser> {
  const response = await apiRequest<unknown>({
    path: '/api/users/me',
    method: 'PUT',
    token,
    data: { nickname },
  })
  return parseUserResponse(response)
}

export async function uploadAvatar(
  token: string,
  filePath: string,
  nickname: string,
): Promise<AuthUser> {
  const response = await apiUploadFile<unknown>({
    path: '/api/users/me/avatar',
    filePath,
    token,
    formData: { nickname },
  })
  return parseUserResponse(response)
}

function getWechatLoginCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      timeout: 10_000,
      success: ({ code }) => {
        if (code) {
          resolve(code)
          return
        }
        reject(new ApiError('微信登录未返回有效凭证，请重新尝试。', { code: 'WX_LOGIN_FAILED' }))
      },
      fail: () => {
        reject(new ApiError('微信登录未完成，请检查网络后重新尝试。', { code: 'WX_LOGIN_FAILED' }))
      },
    })
  })
}

function parseLoginResponse(value: unknown): AuthSession {
  if (!isRecord(value)) throw invalidResponse()
  const user = parseUser(value.user)
  if (
    typeof value.token !== 'string'
    || value.token.length < 16
    || typeof value.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.expiresAt))
    || !user
  ) throw invalidResponse()

  return {
    token: value.token,
    expiresAt: value.expiresAt,
    user,
  }
}

function parseUserResponse(value: unknown): AuthUser {
  if (!isRecord(value)) throw invalidResponse()
  const user = parseUser(value.user)
  if (!user) throw invalidResponse()
  return user
}

function parseCurrentUserResponse(value: unknown): CurrentUserProfile {
  if (!isRecord(value) || !isRecord(value.user) || !isRecord(value.stats) || !isRecord(value.quota)) {
    throw invalidResponse()
  }

  const user = parseUser(value.user)
  const createdAt = value.user.createdAt
  const stats = value.stats
  const quota = value.quota
  if (
    !user
    || typeof createdAt !== 'string'
    || !isFiniteNumber(stats.workCount)
    || !isFiniteNumber(stats.favoriteCount)
    || !isFiniteNumber(stats.downloadCount)
    || !isFiniteNumber(quota.dailyFree)
    || !isFiniteNumber(quota.usedToday)
    || !isFiniteNumber(quota.purchased)
    || !isFiniteNumber(quota.remaining)
    || typeof quota.resetsAt !== 'string'
  ) throw invalidResponse()

  return {
    user: { ...user, createdAt },
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

function parseUser(value: unknown): AuthUser | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null
  if (value.nickname !== null && typeof value.nickname !== 'string') return null
  if (value.avatarUrl !== null && typeof value.avatarUrl !== 'string') return null
  const avatarUrl = resolveAvatarUrl(value.avatarUrl)
  if (value.avatarUrl !== null && !avatarUrl) return null
  return { id: value.id, nickname: value.nickname, avatarUrl }
}

function resolveAvatarUrl(value: string | null): string | null {
  if (value === null) return null
  if (/^https:\/\//i.test(value) || /^http:\/\/127\.0\.0\.1(?::\d+)?\//i.test(value)) return value
  if (!value.startsWith('/api/media/avatars/')) return null
  try {
    return buildApiUrl(value)
  } catch {
    return null
  }
}

function invalidResponse(): ApiError {
  return new ApiError('服务返回了无法识别的数据，请稍后重试。', { code: 'INVALID_RESPONSE' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
