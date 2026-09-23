/**
 * 登录态与用户信息的全局 store（小程序端单例）。
 *
 * 职责：维护 AuthState 状态机（guest/restoring/authenticating/authenticated/refreshing/
 *       updating/error/expired）、登录/刷新/登出、保存昵称、删除账号、刷新下载与 AI 额度，
 *       并在登录成功后恢复云端作品与收藏。不做网络请求本身——具体接口封装在 services/auth-service、
 *       services/download-service。
 * 调用方：各页面（account、profile 等）通过 authStore 订阅状态；app-store 在 restore 时联动激活账号。
 * 关键点：401 / TOKEN_EXPIRED / UNAUTHORIZED 视为未授权，会清空 session 并进入 expired；
 *        刷新失败会退回已缓存的离线 profile 并标记 isOffline，保证页面仍可用。
 */
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

/** 登录状态的有限状态机取值（用于驱动页面的加载/登录/错误展示）。 */
export type AuthStatus =
  | 'guest'
  | 'restoring'
  | 'authenticating'
  | 'authenticated'
  | 'refreshing'
  | 'updating'
  | 'error'
  | 'expired'

/** 全局登录态快照：当前状态、用户、完整 profile、是否离线及错误信息。 */
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

/**
 * 登录态与用户信息的全局 store 单例类。
 * 通过 subscribe 订阅状态变化驱动 UI；对外提供登录、刷新、登出、改昵称、删号、刷新额度等能力。
 */
export class AuthStore {
  private state: AuthState = { ...initialState }
  private listeners = new Set<AuthListener>()
  private restoreTask: Promise<void> | null = null

  /** 返回当前状态快照（只读），供订阅者与页面读取。 */
  getSnapshot(): Readonly<AuthState> {
    return this.state
  }

  /**
   * 判断当前是否已登录。
   * 注意：restoring/refreshing/updating 也视为“已登录”，因为这些状态下用户已存在只是正在刷新。
   */
  isLoggedIn(): boolean {
    const user = this.state.profile?.user ?? this.state.user
    return Boolean(user) && (
      this.state.status === 'authenticated'
      || this.state.status === 'refreshing'
      || this.state.status === 'restoring'
      || this.state.status === 'updating'
    )
  }

  /** 订阅状态变化：立即回调一次当前状态，返回取消订阅的函数。 */
  subscribe(listener: AuthListener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  /** 冷启动恢复登录态：用 token-storage 里的 session 重建状态，并发请求拉取 profile；并发去重。 */
  restore(): Promise<void> {
    if (this.restoreTask) return this.restoreTask
    this.restoreTask = this.performRestore().finally(() => {
      this.restoreTask = null
    })
    return this.restoreTask
  }

  /** 微信登录：拿 wx.login 的 code 换取 token，激活会话。已登录中或 401 过期则直接返回。 */
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

  /** 刷新用户信息：用本地 session 调 /api/users/me 取最新 profile 并恢复云端数据；失败则退回离线缓存。 */
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
      // 刷新接口失败但本地有缓存：退到离线 profile，保证页面仍然可用
      await this.fallbackToOffline(session, error)
    }
  }

  /**
   * 网络刷新失败后的离线降级。
   *
   * 注意：本地会话完全可能既没有 profile.user 也没有 user（历史脏数据 / 写入中断），
   * 此时解引用会抛 TypeError —— 而这里正是「接口已经失败」的兜底路径，
   * 在兜底里再抛一次等于完全没有兜底，页面会永远卡在 refreshing。
   * 拿不到用户身份时应判定登录过期让用户重新登录，而不是硬撑出一个残缺态。
   * @returns 是否成功降级到离线可用态
   */
  private async fallbackToOffline(session: AuthSession, error: unknown): Promise<boolean> {
    const cachedUser = session.profile?.user ?? session.user
    if (!cachedUser?.id) {
      this.expireSession()
      return false
    }
    await appStore.activateAccount(cachedUser.id)
    this.setState({
      status: 'authenticated',
      user: cachedUser,
      profile: session.profile ?? null,
      isOffline: true,
      errorMessage: friendlyAuthError(error),
    })
    return true
  }

  /** 刷新标准下载额度（dailyFree/usedToday/purchased/remaining），写入本地 profile 缓存；过期则进 expired。 */
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

  /** 刷新 AI 生成额度（仅更新 quota.aiGeneration 部分），用于充值页与支付成功页。 */
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

  /** 保存昵称：调接口更新，若遇 401 会先用微信重新登录再试一次；session 失效则抛错。 */
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

  /** 删除账号：调 /api/users/me(DELETE) 后本地登出；session 失效或接口 401 会先过期再抛错。 */
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

  /** 登出：离开本地账号、清空 session 并重置为 guest 态。 */
  async logout(): Promise<void> {
    await appStore.leaveAccount()
    clearAuthSession()
    this.setState({ ...initialState })
  }

  /** 清除 error 态，回到 guest（仅当当前处于 error 时生效）。 */
  clearError(): void {
    if (this.state.status !== 'error') return
    this.setState({ ...initialState })
  }

  /** 服务端下载成功后同步本地额度展示（remaining/usedToday/purchased 以服务端为准）。 */
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

  /** 本地乐观更新下载次数：扣减当日免费额度（封顶 dailyFree）并累加 downloaded 计数，便于 UI 即时反馈。 */
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
        // 当日免费额度的乐观扣减：封顶 dailyFree，避免本地计数超过上限
        usedToday: Math.min(profile.quota.dailyFree, profile.quota.usedToday + 1),
        remaining: Math.max(0, nextFreeQuota + profile.quota.purchased),
      },
    }
    this.persistProfileCache(nextProfile)
    this.setState({ ...this.state, user: nextProfile.user, profile: nextProfile })
  }

  /** 用户已看到“登录过期”提示后调用，将 expired 态收回到 guest。 */
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
      // 刷新接口失败但本地有缓存：退到离线 profile，保证页面仍然可用
      await this.fallbackToOffline(session, error)
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
      const PAGE_SIZE = 50
      // 分页上限：哪怕是服务端分页字段失灵，也不能让用户在这个循环里无限打请求。
      // 收藏不会无限增长，按 total 取一轮最多也就几页，给足余量即可。
      const MAX_PAGES = 20
      const [works, firstFavorites] = await Promise.all([
        fetchCloudWorks(),
        fetchCloudFavorites({ page: 1, pageSize: PAGE_SIZE }),
      ])
      const cloudFavorites = [...firstFavorites.items]
      // 页码用**本地计数器**推进，不信服务端回的 page/pageSize：
      // 那两个字段一旦缺失，undefined + 1 会变成 NaN，请求反复打到同一页，
      // items 永远非空而 total 永远追不上 —— 死循环 + 请求风暴。
      let page = 1
      while (page < MAX_PAGES && cloudFavorites.length < firstFavorites.total && firstFavorites.items.length > 0) {
        page += 1
        const next = await fetchCloudFavorites({ page, pageSize: PAGE_SIZE })
        // 服务端无视页码返回了同一批 id：继续翻下去只会重复 append
        if (next.items.length === 0) break
        const before = cloudFavorites.length
        for (const item of next.items) {
          if (!cloudFavorites.some((existing) => existing.id === item.id)) cloudFavorites.push(item)
        }
        if (cloudFavorites.length === before) break
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

/** 全局单例 store，页面与 app-store 共享同一份登录态。 */
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
