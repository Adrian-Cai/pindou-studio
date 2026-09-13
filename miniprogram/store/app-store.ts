import { isGenerationMode, type DownloadRecord, type PatternDraft, type WorkItem } from '../models/pattern'

interface Workspace { currentDraft: PatternDraft | null; localDrafts: Record<string, PatternDraft>; works: WorkItem[]; favoriteIds: string[]; downloadQuota: number; downloadQuotaDate: string; downloadRecords: DownloadRecord[] }
interface PersistedState { version: 2; guest: Workspace; accounts: Record<string, Workspace> }
interface AppState extends Workspace {}
interface LegacyState extends Partial<Workspace> {}

const STORAGE_KEY = 'pindou-app-state-v2'
const LEGACY_STORAGE_KEY = 'pindou-app-state-v1'
export const DAILY_FREE_DOWNLOAD_QUOTA = 9
type Listener = (state: Readonly<AppState>) => void

export class LocalStorageError extends Error {
  constructor(message: string) { super(message); this.name = 'LocalStorageError' }
}

/** 云端数据仅留在运行期；持久化内容只有游客与按账号隔离的离线队列。 */
export class AppStore {
  private persisted: PersistedState = { version: 2, guest: createWorkspace(), accounts: {} }
  private activeUserId: string | null = null
  private cloudWorks: WorkItem[] = []
  private cloudDraft: PatternDraft | null = null
  private state: AppState = createWorkspace()
  private listeners = new Set<Listener>()
  private writeTask: Promise<void> = Promise.resolve()

  hydrate(): void {
    try {
      const saved = wx.getStorageSync<unknown>(STORAGE_KEY)
      this.persisted = isPersistedState(saved) ? normalizePersistedState(saved) : this.migrateLegacy()
      this.rebuildState()
      if (!isPersistedState(saved)) void this.persist()
    } catch (error) {
      console.warn('读取本地状态失败', error)
      this.persisted = { version: 2, guest: createWorkspace(), accounts: {} }
      this.rebuildState()
    }
  }

  getSnapshot(): Readonly<AppState> { return this.state }
  subscribe(listener: Listener): () => void { this.listeners.add(listener); listener(this.state); return () => this.listeners.delete(listener) }
  getActiveUserId(): string | null { return this.activeUserId }
  getGuestWorkCount(): number { return this.persisted.guest.works.length }

  async activateAccount(userId: string): Promise<void> {
    if (!userId) throw new Error('账号标识无效')
    if (!this.persisted.accounts[userId]) this.persisted.accounts[userId] = createWorkspace()
    if (this.activeUserId !== userId) { this.activeUserId = userId; this.cloudWorks = []; this.cloudDraft = null; this.rebuildState() }
    await this.persist()
  }

  async leaveAccount(): Promise<void> {
    this.cloudWorks = []; this.cloudDraft = null; this.activeUserId = null; this.rebuildState(); await this.persist()
  }

  /** 登录成功后将游客作品移入当前账号的待同步队列。 */
  async adoptGuestWorks(userId: string): Promise<number> {
    if (this.activeUserId !== userId) throw new Error('当前账号数据空间未准备好')
    const guest = this.persisted.guest
    const account = this.getActiveWorkspace()
    const ids = new Set(guest.works.map((work) => work.id))
    const works = guest.works.map((work) => ({ ...work, syncStatus: 'pending' as const, ownerId: userId, isCloud: false, syncError: undefined }))
    account.works = mergeWorks(works, account.works)
    account.favoriteIds = unique([...account.favoriteIds, ...guest.favoriteIds.filter((id) => ids.has(id))])
    account.localDrafts = { ...guest.localDrafts, ...account.localDrafts }
    if (guest.currentDraft && ids.has(guest.currentDraft.id)) account.currentDraft = guest.currentDraft
    this.persisted.guest = createWorkspace()
    this.rebuildState(); await this.persist(); return works.length
  }

  setCurrentDraft(currentDraft: PatternDraft | null): Promise<void> {
    const isCloudDraft = Boolean(currentDraft && this.activeUserId && this.cloudWorks.some((work) => work.id === currentDraft.id))
    if (isCloudDraft) this.cloudDraft = currentDraft
    else { this.cloudDraft = null; this.getActiveWorkspace().currentDraft = currentDraft }
    this.rebuildState(); return this.persist()
  }
  saveLocalDraft(draft: PatternDraft): Promise<void> { const w = this.getActiveWorkspace(); w.localDrafts = { ...w.localDrafts, [draft.id]: draft }; w.currentDraft = draft; this.rebuildState(); return this.persist() }
  getLocalDraft(workId: string): PatternDraft | null { return this.getActiveWorkspace().localDrafts[workId] ?? null }
  removeLocalDraft(workId: string): Promise<void> { const w = this.getActiveWorkspace(); if (!w.localDrafts[workId] && w.currentDraft?.id !== workId) return Promise.resolve(); const drafts = { ...w.localDrafts }; delete drafts[workId]; w.localDrafts = drafts; if (w.currentDraft?.id === workId) w.currentDraft = null; this.rebuildState(); return this.persist() }

  saveWork(work: WorkItem): Promise<void> {
    if (isSynced(work)) {
      this.cloudWorks = mergeWorks([{ ...work, syncStatus: 'synced', isCloud: true }], this.cloudWorks)
      this.updateFavoriteId(work.id, work.isFavorite)
    } else {
      const normalized: WorkItem = this.activeUserId
        ? { ...work, syncStatus: work.syncStatus === 'failed' ? 'failed' : 'pending' as const, ownerId: this.activeUserId, isCloud: false }
        : { ...work, syncStatus: 'guest' as const, ownerId: undefined, isCloud: false }
      const w = this.getActiveWorkspace(); w.works = mergeWorks([normalized], w.works)
    }
    this.rebuildState(); return this.persist()
  }

  markSyncStatus(workId: string, status: 'pending' | 'failed', syncError?: string): Promise<void> {
    const w = this.getActiveWorkspace()
    w.works = w.works.map((work) => work.id === workId ? { ...work, syncStatus: status, syncError, ownerId: this.activeUserId ?? undefined, isCloud: false } : work)
    this.rebuildState(); return this.persist()
  }
  getSyncCandidates(userId: string): WorkItem[] { return (this.persisted.accounts[userId]?.works ?? []).filter((work) => work.syncStatus === 'pending' || work.syncStatus === 'failed') }

  async replaceLocalWorkWithCloud(localId: string, cloudWork: WorkItem): Promise<void> {
    const w = this.getActiveWorkspace()
    const wasFavorite = w.favoriteIds.includes(localId)
    w.works = w.works.filter((item) => item.id !== localId)
    w.favoriteIds = unique(w.favoriteIds.map((id) => id === localId ? cloudWork.id : id))
    w.downloadRecords = w.downloadRecords.map((record) => record.workId === localId ? { ...record, workId: cloudWork.id } : record)
    const drafts = { ...w.localDrafts }; delete drafts[localId]; w.localDrafts = drafts
    if (w.currentDraft?.id === localId) {
      this.cloudDraft = { ...w.currentDraft, id: cloudWork.id, sourceImagePath: '' }
      w.currentDraft = null
    }
    this.cloudWorks = mergeWorks([{
      ...cloudWork,
      isFavorite: wasFavorite || cloudWork.isFavorite === true,
      syncStatus: 'synced',
      isCloud: true,
    }], this.cloudWorks)
    this.rebuildState(); await this.persist()
  }

  replaceCloudWorks(works: WorkItem[]): Promise<void> {
    const w = this.getActiveWorkspace()
    this.cloudWorks = works.map((work) => ({ ...work, syncStatus: 'synced', isCloud: true }))
    const incomingIds = new Set(this.cloudWorks.map((work) => work.id))
    const incomingFavoriteIds = new Set(this.cloudWorks.filter((work) => work.isFavorite === true).map((work) => work.id))
    w.favoriteIds = unique([
      ...w.favoriteIds.filter((id) => !incomingIds.has(id)),
      ...incomingFavoriteIds,
    ])
    this.syncPersistedFavoriteState(w, incomingIds, incomingFavoriteIds)
    this.rebuildState(); return this.persist()
  }
  replaceCloudFavorites(favorites: WorkItem[]): Promise<void> {
    const w = this.getActiveWorkspace()
    const knownCloudIds = new Set([
      ...this.cloudWorks.map((work) => work.id),
      ...w.works.filter(isSynced).map((work) => work.id),
    ])
    const favoriteIds = new Set(favorites.map((work) => work.id))
    const byId = new Map(favorites.map((work) => [work.id, { ...work, syncStatus: 'synced' as const, isCloud: true }]))
    this.cloudWorks = this.cloudWorks.map((work) => byId.get(work.id) ?? { ...work, favoritedAt: undefined, isFavorite: false })
    byId.forEach((work) => { if (!this.cloudWorks.some((item) => item.id === work.id)) this.cloudWorks.unshift(work) })
    w.favoriteIds = unique([
      ...w.favoriteIds.filter((id) => !knownCloudIds.has(id)),
      ...favoriteIds,
    ])
    this.syncPersistedFavoriteState(w, knownCloudIds, favoriteIds)
    this.rebuildState(); return this.persist()
  }

  setFavorite(workId: string, favorite: boolean, favoritedAt = Date.now()): Promise<void> {
    const w = this.getActiveWorkspace(); w.favoriteIds = favorite ? unique([...w.favoriteIds, workId]) : w.favoriteIds.filter((id) => id !== workId)
    w.works = applyFavorite(w.works, workId, favorite, favoritedAt); this.cloudWorks = applyFavorite(this.cloudWorks, workId, favorite, favoritedAt)
    this.rebuildState(); return this.persist()
  }
  deleteWork(workId: string): Promise<void> {
    const w = this.getActiveWorkspace(); w.works = w.works.filter((item) => item.id !== workId); w.favoriteIds = w.favoriteIds.filter((id) => id !== workId); w.downloadRecords = w.downloadRecords.filter((item) => item.workId !== workId); if (w.currentDraft?.id === workId) w.currentDraft = null
    const drafts = { ...w.localDrafts }; delete drafts[workId]; w.localDrafts = drafts; this.cloudWorks = this.cloudWorks.filter((item) => item.id !== workId)
    this.rebuildState(); return this.persist()
  }
  addDownloadRecord(record: DownloadRecord): Promise<void> { const w = this.getActiveWorkspace(); w.downloadRecords = [record, ...w.downloadRecords.filter((item) => item.id !== record.id)]; this.rebuildState(); return this.persist() }
  setDownloadQuota(quota: number): Promise<void> { const w = this.getActiveWorkspace(); w.downloadQuota = normalizeQuota(quota); w.downloadQuotaDate = dateKey(); this.rebuildState(); return this.persist() }
  refreshDownloadQuota(): number { const w = this.getActiveWorkspace(); if (w.downloadQuotaDate !== dateKey()) { w.downloadQuota = DAILY_FREE_DOWNLOAD_QUOTA; w.downloadQuotaDate = dateKey(); this.rebuildState(); void this.persist() }; return w.downloadQuota }
  completeDownload(record: DownloadRecord): number | null { if (this.refreshDownloadQuota() <= 0) return null; const w = this.getActiveWorkspace(); w.downloadQuota -= 1; w.downloadRecords = [record, ...w.downloadRecords.filter((item) => item.id !== record.id)]; this.rebuildState(); void this.persist(); return w.downloadQuota }

  private getActiveWorkspace(): Workspace { if (!this.activeUserId) return this.persisted.guest; return this.persisted.accounts[this.activeUserId] ?? (this.persisted.accounts[this.activeUserId] = createWorkspace()) }
  private updateFavoriteId(workId: string, isFavorite?: boolean): void {
    if (isFavorite === undefined) return
    const w = this.getActiveWorkspace()
    w.favoriteIds = isFavorite ? unique([...w.favoriteIds, workId]) : w.favoriteIds.filter((id) => id !== workId)
  }
  private syncPersistedFavoriteState(w: Workspace, knownCloudIds: Set<string>, favoriteIds: Set<string>): void {
    w.works = w.works.map((work) => {
      if (!knownCloudIds.has(work.id)) return work
      const isFavorite = favoriteIds.has(work.id)
      return { ...work, isFavorite, favoritedAt: isFavorite ? work.favoritedAt : undefined }
    })
  }
  private rebuildState(): void {
    const w = this.getActiveWorkspace()
    const favoriteIds = unique(w.favoriteIds)
    const works = mergeWorks(this.cloudWorks, w.works).map((work) => ({
      ...work,
      isFavorite: favoriteIds.includes(work.id),
    }))
    this.state = { ...cloneWorkspace(w), currentDraft: this.cloudDraft ?? w.currentDraft, works, favoriteIds }
    this.listeners.forEach((listener) => listener(this.state))
  }
  private persist(): Promise<void> {
    const payload = this.persisted
    this.writeTask = this.writeTask.catch(() => undefined).then(() => new Promise<void>((resolve, reject) => wx.setStorage({ key: STORAGE_KEY, data: payload, success: () => resolve(), fail: (error) => reject(new LocalStorageError(storageMessage(error))) })))
    return this.writeTask
  }
  private migrateLegacy(): PersistedState {
    const legacy = wx.getStorageSync<LegacyState>(LEGACY_STORAGE_KEY)
    if (!legacy || !Array.isArray(legacy.works)) return { version: 2, guest: createWorkspace(), accounts: {} }
    return { version: 2, guest: normalizeWorkspace({ ...legacy, works: legacy.works.filter((work) => !work.isCloud).map((work) => ({ ...work, syncStatus: 'guest', isCloud: false })) }), accounts: {} }
  }
}

export const appStore = new AppStore()
function createWorkspace(): Workspace { return { currentDraft: null, localDrafts: {}, works: [], favoriteIds: [], downloadQuota: DAILY_FREE_DOWNLOAD_QUOTA, downloadQuotaDate: dateKey(), downloadRecords: [] } }
function cloneWorkspace(w: Workspace): Workspace { return { ...w, localDrafts: { ...w.localDrafts }, works: [...w.works], favoriteIds: [...w.favoriteIds], downloadRecords: [...w.downloadRecords] } }
function normalizeWorkspace(w: Partial<Workspace>): Workspace {
  return {
    ...createWorkspace(),
    ...w,
    currentDraft: w.currentDraft ? normalizeDraft(w.currentDraft) : null,
    localDrafts: Object.fromEntries(Object.entries(w.localDrafts ?? {}).map(([id, draft]) => [id, normalizeDraft(draft)])),
    works: (w.works ?? []).map(normalizeWork),
    favoriteIds: w.favoriteIds ?? [],
    downloadRecords: w.downloadRecords ?? [],
  }
}
function normalizePersistedState(state: PersistedState): PersistedState { return { version: 2, guest: normalizeWorkspace(state.guest), accounts: Object.fromEntries(Object.entries(state.accounts ?? {}).map(([id, w]) => [id, normalizeWorkspace(w)])) } }
function isPersistedState(value: unknown): value is PersistedState { return typeof value === 'object' && value !== null && (value as { version?: unknown }).version === 2 && typeof (value as { guest?: unknown }).guest === 'object' }
function isSynced(work: WorkItem): boolean { return work.syncStatus === 'synced' || work.isCloud === true }
function normalizeDraft(draft: PatternDraft): PatternDraft {
  return { ...draft, generationMode: isGenerationMode(draft.generationMode) ? draft.generationMode : (draft.id.startsWith('ai-pending-') ? 'ai' : 'standard') }
}
function normalizeWork(work: WorkItem): WorkItem { return { ...work, generationMode: isGenerationMode(work.generationMode) ? work.generationMode : 'standard' } }
function mergeWorks(first: WorkItem[], second: WorkItem[]): WorkItem[] { const seen = new Set<string>(); return [...first, ...second].filter((work) => !seen.has(work.id) && (seen.add(work.id), true)) }
function applyFavorite(works: WorkItem[], id: string, favorite: boolean, at: number): WorkItem[] { return works.map((work) => work.id === id ? { ...work, isFavorite: favorite, favoritedAt: favorite ? at : undefined } : work) }
function unique(values: string[]): string[] { return [...new Set(values)] }
function dateKey(): string { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function normalizeQuota(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DAILY_FREE_DOWNLOAD_QUOTA }
function storageMessage(error: unknown): string { const raw = typeof (error as { errMsg?: unknown })?.errMsg === 'string' ? (error as { errMsg: string }).errMsg : ''; return /exceed|limit/i.test(raw) ? '本机存储空间不足，请清理空间后重试' : '本机保存失败，请稍后重试' }
