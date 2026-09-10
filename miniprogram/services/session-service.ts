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
  const session = await loginWithWechat()
  securitySession = session
  return session
}

