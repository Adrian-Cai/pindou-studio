import type { AuthSession, AuthUser, CurrentUserProfile } from '../models/auth'
import {
  fetchCurrentUser,
  loginWithWechat,
  updateNickname,
  uploadAvatar,
} from '../services/auth-service'
import { ApiError } from '../services/http-client'
import {
  clearAuthSession,
  isAuthSessionExpired,
  loadAuthSession,
  saveAuthSession,
} from '../services/token-storage'

export type AuthStatus =
  | 'guest'
  | 'restoring'
  | 'authenticating'
  | 'authenticated'
  | 'refreshing'
  | 'updating'
  | 'error'
  | 'expired'

export interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  profile: CurrentUserProfile | null
  isOffline: boolean
  errorMessage: string
}

type AuthListener = (state: Readonly<AuthState>) => void

const initialState: AuthState = {
  status: 'guest',
  user: null,
  profile: null,
  isOffline: false,
  errorMessage: '',
}

export class AuthStore {
  private state: AuthState = { ...initialState }
  private listeners = new Set<AuthListener>()
  private restoreTask: Promise<void> | null = null

  getSnapshot(): Readonly<AuthState> {
    return this.state
  }

  subscribe(listener: AuthListener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  restore(): Promise<void> {
    if (this.restoreTask) return this.restoreTask
    this.restoreTask = this.performRestore().finally(() => {
      this.restoreTask = null
    })
    return this.restoreTask
  }

  async login(): Promise<void> {
    if (this.state.status === 'authenticating') return
    this.setState({ ...initialState, status: 'authenticating' })

    try {
      const session = await loginWithWechat()
      saveAuthSession(session)
      await this.activateSession(session)
    } catch (error) {
      if (isUnauthorized(error)) {
        this.expireSession()
        return
      }
      this.setState({
        ...initialState,
        status: 'error',
        errorMessage: friendlyAuthError(error),
      })
    }
  }

  async refresh(): Promise<void> {
    const session = loadAuthSession()
    if (!session || isAuthSessionExpired(session)) {
      this.expireSession()
      return
    }

    this.setState({
      ...this.state,
      status: 'refreshing',
      errorMessage: '',
    })
    try {
      const profile = await fetchCurrentUser(session.token)
      saveAuthSession({ ...session, user: profile.user, profile })
      this.setState({
        status: 'authenticated',
        user: profile.user,
        profile,
        isOffline: false,
        errorMessage: '',
      })
    } catch (error) {
      if (isUnauthorized(error)) {
        this.expireSession()
        return
      }
      this.setState({
        status: 'authenticated',
        user: session.profile?.user ?? session.user,
        profile: session.profile ?? null,
        isOffline: true,
        errorMessage: friendlyAuthError(error),
      })
    }
  }

  async saveProfile(nickname: string, avatarFilePath?: string): Promise<void> {
    const session = loadAuthSession()
    if (!session || isAuthSessionExpired(session)) {
      this.expireSession()
      throw new Error('登录状态已失效，请重新登录。')
    }

    const previousState = this.state
    this.setState({ ...this.state, status: 'updating', errorMessage: '' })
    try {
      if (avatarFilePath) {
        await uploadAvatar(session.token, avatarFilePath, nickname)
      } else {
        await updateNickname(session.token, nickname)
      }
      const profile = await fetchCurrentUser(session.token)
      saveAuthSession({ ...session, user: profile.user, profile })
      this.setState({
        status: 'authenticated',
        user: profile.user,
        profile,
        isOffline: false,
        errorMessage: '',
      })
    } catch (error) {
      if (isUnauthorized(error)) {
        this.expireSession()
        throw new Error('登录状态已失效，请重新登录。')
      }
      const message = friendlyAuthError(error)
      this.setState({ ...previousState, status: 'authenticated', errorMessage: message })
      throw new Error(message)
    }
  }

  logout(): void {
    clearAuthSession()
    this.setState({ ...initialState })
  }

  clearError(): void {
    if (this.state.status !== 'error') return
    this.setState({ ...initialState })
  }

  acknowledgeExpiry(): void {
    if (this.state.status !== 'expired') return
    this.setState({ ...initialState })
  }

  private async performRestore(): Promise<void> {
    const session = loadAuthSession()
    if (!session) {
      this.setState({ ...initialState })
      return
    }
    if (isAuthSessionExpired(session)) {
      this.expireSession()
      return
    }

    this.setState({
      status: 'restoring',
      user: session.profile?.user ?? session.user,
      profile: session.profile ?? null,
      isOffline: false,
      errorMessage: '',
    })
    await this.activateSession(session)
  }

  private async activateSession(session: AuthSession): Promise<void> {
    try {
      const profile = await fetchCurrentUser(session.token)
      saveAuthSession({ ...session, user: profile.user, profile })
      this.setState({
        status: 'authenticated',
        user: profile.user,
        profile,
        isOffline: false,
        errorMessage: '',
      })
    } catch (error) {
      if (isUnauthorized(error)) {
        this.expireSession()
        return
      }
      this.setState({
        status: 'authenticated',
        user: session.profile?.user ?? session.user,
        profile: session.profile ?? null,
        isOffline: true,
        errorMessage: friendlyAuthError(error),
      })
    }
  }

  private expireSession(): void {
    clearAuthSession()
    this.setState({ ...initialState, status: 'expired' })
  }

  private setState(state: AuthState): void {
    this.state = state
    this.listeners.forEach((listener) => listener(this.state))
  }
}

export const authStore = new AuthStore()

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError
    && (error.statusCode === 401 || error.code === 'UNAUTHORIZED' || error.code === 'TOKEN_EXPIRED')
}

function friendlyAuthError(error: unknown): string {
  if (!(error instanceof ApiError)) return '登录服务暂时不可用，请稍后重试。'
  if (error.code === 'NETWORK_ERROR') return '网络连接失败，请检查网络后重试。'
  if (error.code === 'API_CONFIGURATION_ERROR') return error.message
  if (error.code === 'WX_LOGIN_FAILED') return error.message
  if (error.code === 'INVALID_ARGUMENT') return '微信登录凭证无效，请重新登录。'
  if (error.statusCode === 404) return '登录接口尚未部署，请检查并重启后端服务。'
  if (error.statusCode >= 500) return '登录服务暂时不可用，请稍后重试。'
  return error.message || '登录失败，请重新尝试。'
}
