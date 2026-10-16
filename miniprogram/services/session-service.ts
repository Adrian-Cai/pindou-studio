import type { AuthSession } from '../models/auth'
import { loginWithWechat } from './auth-service'
import { ApiError } from './http-client'
import { isQqEnvironment } from '../config/platform'
import {
  isAuthSessionExpired,
  loadAuthSession,
} from './token-storage'

let securitySession: AuthSession | null = null

/** 清除内容安全等服务复用的内存登录会话。 */
export function clearSecuritySession(): void {
  securitySession = null
}

export async function ensureLoggedInSession(): Promise<AuthSession> {
  const current = loadAuthSession()
  if (current && !isAuthSessionExpired(current)) return current
  if (securitySession && !isAuthSessionExpired(securitySession)) return securitySession
  let session: AuthSession
  try {
    if (isQqEnvironment()) {
      throw new ApiError('请先在“我的”页选择 QQ 登录或绑定已有微信账号', {
        statusCode: 401,
        code: 'LOGIN_REQUIRED',
      })
    }
    session = await loginWithWechat()
  } catch (error) {
    // 微信登录或换 token 失败时的原始错误没有可读性（多为 wx.login 的 errMsg）。
    // 这里统一换成能提示用户下一步动作的文案，同时保留原始错误供排查。
    console.error('自动登录失败', error)
    throw new Error('登录失败，请检查网络后重试')
  }
  securitySession = session
  return session
}

/** 返回用户明确登录后持久化的会话；不复用内容安全链路创建的临时会话。 */
export function requireLoggedInSession(): AuthSession {
  const session = loadAuthSession()
  if (!session || isAuthSessionExpired(session)) {
    throw new ApiError('请先登录后使用 AI 功能', { statusCode: 401, code: 'LOGIN_REQUIRED' })
  }
  return session
}

