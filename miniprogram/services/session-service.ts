import type { AuthSession } from '../models/auth'
import { loginWithWechat } from './auth-service'
import {
  isAuthSessionExpired,
  loadAuthSession,
} from './token-storage'

let securitySession: AuthSession | null = null

export async function ensureLoggedInSession(): Promise<AuthSession> {
  const current = loadAuthSession()
  if (current && !isAuthSessionExpired(current)) return current
  if (securitySession && !isAuthSessionExpired(securitySession)) return securitySession
  let session: AuthSession
  try {
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

