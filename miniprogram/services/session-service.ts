import type { AuthSession } from '../models/auth'
import { loginWithWechat } from './auth-service'
import {
  isAuthSessionExpired,
  loadAuthSession,
  saveAuthSession,
} from './token-storage'

export async function ensureLoggedInSession(): Promise<AuthSession> {
  const current = loadAuthSession()
  if (current && !isAuthSessionExpired(current)) return current
  const session = await loginWithWechat()
  saveAuthSession(session)
  return session
}
