import type { AuthSession, AuthUser, CurrentUserProfile } from '../models/auth'
import {
  deleteCurrentUser,
  fetchCurrentUser,
  loginWithWechat,
  updateNickname,
} from '../services/auth-service'
import { fetchQuota, type QuotaResponse } from '../services/download-service'
import { ApiError } from '../services/http-client'
import {
  clearAuthSession,
  isAuthSessionExpired,
  loadAuthSession,
  saveAuthSession,
} from '../services/token-storage'
import { appStore } from './app-store'
import { cloudSummaryToWorkItem, fetchCloudFavorites, fetchCloudWorks } from '../services/work-service'
import { syncPendingWorks } from '../services/work-sync-service'

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

  isLoggedIn(): boolean {
    const user = this.state.profile?.user ?? this.state.user
    return Boolean(user) && (
      this.state.status === 'authenticated'
      || this.state.status === 'refreshing'
      || this.state.status === 'restoring'
      || this.state.status === 'updating'
    )
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
        status: 'refreshing',
        user: profile.user,
        profile,
        isOffline: false,
        errorMessage: '',
      })
      await this.restoreAccountData(profile.user.id)
      this.setState({ ...this.state, status: 'authenticated', user: profile.user, profile })
    } catch (error) {
      if (isUnauthorized(error)) {
        this.expireSession()
        return
      }
      const cachedUser = session.profile?.user ?? session.user
      await appStore.activateAccount(cachedUser.id)
      this.setState({
        status: 'authenticated',
        user: cachedUser,
        profile: session.profile ?? null,
        isOffline: true,
        errorMessage: friendlyAuthError(error),
      })
    }
  }

  async refreshQuota(): Promise<QuotaResponse | null> {
    const session = loadAuthSession()
    if (!session || isAuthSessionExpired(session)) return null

    try {
      const quota = await fetchQuota()
      const profile = this.state.profile
      if (profile) {
        const nextProfile: CurrentUserProfile = {
          ...profile,
          quota: {
            ...profile.quota,
            dailyFree: quota.dailyFree,
            usedToday: quota.usedToday,
            purchased: quota.purchased,
            remaining: quota.remaining,
            resetsAt: quota.resetsAt,
            aiGeneration: quota.aiGeneration,
          },
        }
        this.persistProfileCache(nextProfile)
        this.setState({ ...this.state, user: nextProfile.user, profile: nextProfile })
      }
      return quota
    } catch (error) {
      if (isUnauthorized(error)) {
        this.expireSession()
        return null
      }
      console.error('刷新下载额度失败', error)
      return null
    }
  }

  async refreshAiQuota(): Promise<QuotaResponse | null> {
    const session = loadAuthSession()
    if (!session || isAuthSessionExpired(session)) return null

    try {
      const quota = await fetchQuota()
      const profile = this.state.profile
      if (profile) {
        const nextProfile: CurrentUserProfile = {
          ...profile,
          quota: {
            ...profile.quota,
            aiGeneration: quota.aiGeneration,
          },
        }
        this.persistProfileCache(nextProfile)
        this.setState({ ...this.state, user: nextProfile.user, profile: nextProfile })
      }
      return quota
    } catch (error) {
      if (isUnauthorized(error)) {
        this.expireSession()
        return null
      }
      console.error('刷新 AI 额度失败', error)
      return null
    }
  }

  async saveProfile(nickname: string): Promise<void> {
    const session = loadAuthSession()
    if (!session || isAuthSessionExpired(session)) {
      this.expireSession()
      throw new Error('登录状态已失效，请重新登录')
    }

    const previousState = this.state
    this.setState({ ...this.state, status: 'updating', errorMessage: '' })
    try {
      let activeSession = session
      let profile: CurrentUserProfile
      try {
        profile = await this.persistProfile(activeSession, nickname)
      } catch (error) {
        if (!isUnauthorized(error)) throw error
        activeSession = await loginWithWechat()
        saveAuthSession(activeSession)
        profile = await this.persistProfile(activeSession, nickname)
      }
      saveAuthSession({ ...activeSession, user: profile.user, profile })
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
        throw new Error('登录状态已失效，请重新登录')
      }
      const message = friendlyAuthError(error)
      this.setState({ ...previousState, status: 'authenticated', errorMessage: message })
      throw new Error(message)
    }
  }

  async deleteAccount(): Promise<void> {
    const session = loadAuthSession()
    if (!session || isAuthSessionExpired(session)) {
      this.expireSession()
      throw new Error('登录状态已失效，请重新登录')
    }

    try {
      await deleteCurrentUser(session.token)
      await this.logout()
    } catch (error) {
      if (isUnauthorized(error)) this.expireSession()
      throw error
    }
  }

  async logout(): Promise<void> {
    await appStore.leaveAccount()
    clearAuthSession()
    this.setState({ ...initialState })
  }

  clearError(): void {
    if (this.state.status !== 'error') return
    this.setState({ ...initialState })
  }

  recordServerDownload(quota: Pick<QuotaResponse, 'remaining' | 'usedToday' | 'purchased'>): void {
    const profile = this.state.profile
    if (!profile) return

    const nextProfile: CurrentUserProfile = {
      ...profile,
      stats: {
        ...profile.stats,
        downloadCount: profile.stats.downloadCount + 1,
      },
      quota: {
        ...profile.quota,
        usedToday: quota.usedToday,
        purchased: quota.purchased,
        remaining: quota.remaining,
      },
    }
    this.persistProfileCache(nextProfile)
    this.setState({ ...this.state, user: nextProfile.user, profile: nextProfile })
  }

  recordLocalDownload(nextFreeQuota: number): void {
    const profile = this.state.profile
    if (!profile) return

    const nextProfile: CurrentUserProfile = {
      ...profile,
      stats: {
        ...profile.stats,
        downloadCount: profile.stats.downloadCount + 1,
      },
      quota: {
        ...profile.quota,
        usedToday: Math.min(profile.quota.dailyFree, profile.quota.usedToday + 1),
        remaining: Math.max(0, nextFreeQuota + profile.quota.purchased),
      },
    }
    this.persistProfileCache(nextProfile)
    this.setState({ ...this.state, user: nextProfile.user, profile: nextProfile })
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
        status: this.state.status === 'restoring' ? 'restoring' : 'authenticating',
        user: profile.user,
        profile,
        isOffline: false,
        errorMessage: '',
      })
      await this.restoreAccountData(profile.user.id)
      this.setState({ ...this.state, status: 'authenticated', user: profile.user, profile })
    } catch (error) {
      if (isUnauthorized(error)) {
        this.expireSession()
        return
      }
      const cachedUser = session.profile?.user ?? session.user
      await appStore.activateAccount(cachedUser.id)
      this.setState({
        status: 'authenticated',
        user: cachedUser,
        profile: session.profile ?? null,
        isOffline: true,
        errorMessage: friendlyAuthError(error),
      })
    }
  }

  private async persistProfile(
    session: AuthSession,
    nickname: string,
  ): Promise<CurrentUserProfile> {
    const user = await updateNickname(session.token, nickname)
    const cachedProfile = session.profile ?? this.state.profile
    if (!cachedProfile) return fetchCurrentUser(session.token)
    return {
      ...cachedProfile,
      user: { ...user, createdAt: cachedProfile.user.createdAt },
    }
  }

  private persistProfileCache(profile: CurrentUserProfile): void {
    const session = loadAuthSession()
    if (session) saveAuthSession({ ...session, user: profile.user, profile })
  }

  private expireSession(): void {
    void appStore.leaveAccount()
    clearAuthSession()
    this.setState({ ...initialState, status: 'expired' })
  }

  private setState(state: AuthState): void {
    this.state = state
    this.listeners.forEach((listener) => listener(this.state))
  }

  private async restoreAccountData(userId: string): Promise<void> {
    await appStore.activateAccount(userId)
    if (appStore.getGuestWorkCount() > 0) await appStore.adoptGuestWorks(userId)
    try {
      const [works, firstFavorites] = await Promise.all([fetchCloudWorks(), fetchCloudFavorites({ pageSize: 50 })])
      const cloudFavorites = [...firstFavorites.items]
      let favorites = firstFavorites
      while (cloudFavorites.length < favorites.total && favorites.items.length > 0) {
        favorites = await fetchCloudFavorites({ page: favorites.page + 1, pageSize: favorites.pageSize })
        cloudFavorites.push(...favorites.items)
      }
      await appStore.replaceCloudWorks(works.items.map(cloudSummaryToWorkItem))
      await appStore.replaceCloudFavorites(cloudFavorites.map(cloudSummaryToWorkItem))
      await syncPendingWorks(userId)
    } catch (error) {
      if (isUnauthorized(error)) throw error
      this.setState({ ...this.state, isOffline: true, errorMessage: friendlyAuthError(error) })
    }
  }
}

export const authStore = new AuthStore()

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError
    && (error.statusCode === 401 || error.code === 'UNAUTHORIZED' || error.code === 'TOKEN_EXPIRED')
}

function friendlyAuthError(error: unknown): string {
  if (!(error instanceof ApiError)) return '登录服务暂时不可用，请稍后重试'
  if (error.code === 'NETWORK_ERROR') return '网络连接失败，请检查网络后重试'
  if (error.code === 'API_CONFIGURATION_ERROR') return error.message
  if (error.code === 'WX_LOGIN_FAILED') return error.message
  if (error.code === 'INVALID_ARGUMENT') return '微信登录凭证无效，请重新登录'
  if (error.statusCode === 404) return '登录接口尚未部署，请检查并重启后端服务'
  if (error.statusCode >= 500) return '登录服务暂时不可用，请稍后重试'
  return error.message || '登录失败，请重新尝试'
}
