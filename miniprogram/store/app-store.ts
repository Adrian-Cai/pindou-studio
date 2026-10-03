/**
 * 本机状态仓库：作品/草稿/收藏/下载记录的唯一内存态与落盘出口。
 *
 * 职责：维护游客与各账号隔离的工作区，所有写操作都在这里串行落盘（persist）；
 *       提供订阅（subscribe）给页面渲染快照；云端数据只留在运行期，不持久化。
 * 调用方：作品列表、编辑器、AI 生成、下载、同步等几乎所有页面与 service。
 * 关键点：整个仓库塞在单个 storage key 里，而微信给单个小程序的 storage 配额只有 10MB，
 *       其中占大头的是草稿网格。因此落盘一律走「调色板 + 下标」压缩（encodeDraft），
 *       并对草稿条数设上限；真写满时先自救裁剪再重试，绝不静默吞掉失败。
 */
import {
  decodePatternCells,
  encodePatternCells,
  isAiTaskWork,
  isGenerationMode,
  resolveSyncFields,
  type CompactDraft,
  type DownloadRecord,
  type PatternDraft,
  type WorkItem,
} from '../models/pattern'

interface Workspace { currentDraft: PatternDraft | null; localDrafts: Record<string, PatternDraft>; works: WorkItem[]; favoriteIds: string[]; downloadQuota: number; downloadQuotaDate: string; downloadRecords: DownloadRecord[] }
interface PersistedState { version: 2; guest: Workspace; accounts: Record<string, Workspace> }
interface AppState extends Workspace {}
interface LegacyState extends Partial<Workspace> {}
/** 落盘态：草稿已压成 CompactDraft，其余与运行态一致。 */
interface StoredWorkspace extends Omit<Workspace, 'currentDraft' | 'localDrafts'> { currentDraft: CompactDraft | null; localDrafts: Record<string, CompactDraft> }
interface StoredPersistedState { version: 2; guest: StoredWorkspace; accounts: Record<string, StoredWorkspace> }

const STORAGE_KEY = 'pindou-app-state-v2'
const LEGACY_STORAGE_KEY = 'pindou-app-state-v1'
export const DAILY_FREE_DOWNLOAD_QUOTA = 9
/**
 * 落盘保留量的两档上限：常态用 MAX，存储写满自救时用 MIN。
 *
 * 两档不是「随便取的两个数」：MAX 是正常使用能攒到的量（下载记录还会展示在下载页，
 * 砍太狠等于删用户历史），MIN 是写满时「至少能腾出空间」的兜底量。
 * 自救裁剪的是**运行态**而非只裁落盘快照，所以自救后运行态就只剩 MIN 条，
 * 后续落盘跟着运行态走，只会随着用户新增下载慢慢涨回 MAX —— 不存在同一份数据在
 * 10↔60 之间反复跳变的情况。
 */
/** 单个工作区落盘保留的草稿上限（当前草稿必留），超出的按创建时间丢最旧的。 */
const MAX_PERSISTED_DRAFTS = 50
/** 存储写满自救时保留的草稿条数。 */
const MIN_PERSISTED_DRAFTS = 8
/** 落盘保留的下载记录条数；记录会随每次下载累加，不设限同样会挤占配额。 */
const MAX_PERSISTED_DOWNLOAD_RECORDS = 60
/** 自救时下载记录保留条数。 */
const MIN_PERSISTED_DOWNLOAD_RECORDS = 10
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
    // AI 占位作品没有图纸，进不了云同步队列；否则登录后会被 sync 判「图案数据不完整」
    const works = guest.works.map((work) => ({
      ...work,
      ...resolveSyncFields(work, userId),
      syncError: undefined,
    }))
    account.works = mergeWorks(works, account.works)
    account.favoriteIds = unique([...account.favoriteIds, ...guest.favoriteIds.filter((id) => ids.has(id))])
    account.localDrafts = { ...guest.localDrafts, ...account.localDrafts }
    if (guest.currentDraft && ids.has(guest.currentDraft.id)) account.currentDraft = guest.currentDraft
    this.persisted.guest = createWorkspace()
    this.rebuildState(); await this.persist(); return works.length
  }

  /**
   * 设置当前正在编辑的草稿。
   *
   * @param currentDraft 目标草稿；传 null 清空当前草稿
   *
   * 前置条件：调用方必须**先**用 `saveWork` 把这份草稿对应的 WorkItem 写进本站
   *   （云端作品即 syncStatus: 'synced' 的形态）。理由是下面这行归属判定依赖
   *   `this.cloudWorks`：若找不到同 id 的云端记录，这份草稿会被当作游客草稿落到
   *   `persisted.guest` 里 —— 用户账号下的作品凭空少一份，游客区多一份脏数据，
   *   而整条链路上没有任何报错。
   */
  setCurrentDraft(currentDraft: PatternDraft | null): Promise<void> {
    const isCloudDraft = Boolean(currentDraft && this.activeUserId && this.cloudWorks.some((work) => work.id === currentDraft.id))
    if (isCloudDraft) this.cloudDraft = currentDraft
    else { this.cloudDraft = null; this.getActiveWorkspace().currentDraft = currentDraft }
    this.rebuildState(); return this.persist()
  }
  saveLocalDraft(draft: PatternDraft, setAsCurrent = true): Promise<void> { const w = this.getActiveWorkspace(); w.localDrafts = { ...w.localDrafts, [draft.id]: draft }; if (setAsCurrent || !w.currentDraft) { w.currentDraft = draft; } this.rebuildState(); return this.persist() }
  getLocalDraft(workId: string): PatternDraft | null { return this.getActiveWorkspace().localDrafts[workId] ?? null }
  removeLocalDraft(workId: string): Promise<void> { const w = this.getActiveWorkspace(); if (!w.localDrafts[workId] && w.currentDraft?.id !== workId) return Promise.resolve(); const drafts = { ...w.localDrafts }; delete drafts[workId]; w.localDrafts = drafts; if (w.currentDraft?.id === workId) w.currentDraft = null; this.rebuildState(); return this.persist() }

  saveWork(work: WorkItem): Promise<void> {
    if (isSynced(work)) {
      this.cloudWorks = mergeWorks([{ ...work, syncStatus: 'synced', isCloud: true }], this.cloudWorks)
      this.updateFavoriteId(work.id, work.isFavorite)
    } else {
      // 归属一律交由 resolveSyncFields 判定：AI 占位作品只存本机，其余进待同步队列
      const normalized: WorkItem = { ...work, ...resolveSyncFields(work, this.activeUserId) }
      const w = this.getActiveWorkspace(); w.works = mergeWorks([normalized], w.works)
    }
    this.rebuildState(); return this.persist()
  }

  markSyncStatus(workId: string, status: 'pending' | 'failed', syncError?: string): Promise<void> {
    const w = this.getActiveWorkspace()
    w.works = w.works.map((work) => {
      if (work.id !== workId) return work
      // AI 占位作品不入云同步：同步结果的回写不得改变它的归属。
      // 否则缺 draft 的那次失败会把它钉成 failed + ownerId，之后每次同步都重试、每次再写回 failed。
      if (isAiTaskWork(work)) return { ...work, ...resolveSyncFields(work, null), syncError: undefined }
      return { ...work, syncStatus: status, syncError, ownerId: this.activeUserId ?? undefined, isCloud: false }
    })
    this.rebuildState(); return this.persist()
  }

  /**
   * 待同步队列：这里是不变式的最后一道防线。
   * 上游写入侧已由 resolveSyncFields 收口，但新增入口或旧版本遗留的数据仍可能带脏 syncStatus，
   * 因此在**离危险最近的位置**再挡一次——只要这里是干净的，占位作品就永远上不了云。
   */
  getSyncCandidates(userId: string): WorkItem[] {
    return (this.persisted.accounts[userId]?.works ?? [])
      .filter((work) => !isAiTaskWork(work))
      .filter((work) => work.syncStatus === 'pending' || work.syncStatus === 'failed')
  }

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
  /**
   * 落盘：压缩 + 裁剪后写入；写满配额时先裁掉最旧的草稿和下载记录再重试一次。
   *
   * 失败仍会向上抛 LocalStorageError —— 静默吞掉会让调用方以为数据已存住，
   * 而实际上冷启动后全部丢失；但自救能覆盖绝大多数「只是攒太多」的场景。
   */
  private persist(): Promise<void> {
    this.writeTask = this.writeTask.catch(() => undefined).then(() => this.persistWithRecovery())
    return this.writeTask
  }

  private async persistWithRecovery(): Promise<void> {
    try {
      await writeStorage(encodePersistedState(this.persisted))
    } catch (error) {
      // 只有「配额写满」值得自救；其余（序列化失败等）重试也无意义
      if (!isStorageQuotaError(error) || !this.shrink()) throw new LocalStorageError(storageMessage(error))
      try {
        await writeStorage(encodePersistedState(this.persisted))
      } catch (retryError) {
        throw new LocalStorageError(storageMessage(retryError))
      }
    }
  }

  /**
   * 空间不足自救：按创建时间丢掉多余的草稿与下载记录，给本次写入腾出空间。
   * 裁剪的是**运行态**（而不只是落盘快照），保证内存与磁盘一致 —— 否则页面还能打开
   * 一份重启后就消失的草稿，反而更误导。当前草稿始终保留。
   * @returns 是否真的腾出了空间
   */
  private shrink(): boolean {
    let removed = false
    const trim = (workspace: Workspace): void => {
      const keepCurrent = workspace.currentDraft?.id
      const drafts = limitDrafts(workspace.localDrafts, keepCurrent, MIN_PERSISTED_DRAFTS)
      if (Object.keys(drafts).length !== Object.keys(workspace.localDrafts).length) {
        workspace.localDrafts = drafts
        removed = true
      }
      if (workspace.downloadRecords.length > MIN_PERSISTED_DOWNLOAD_RECORDS) {
        workspace.downloadRecords = workspace.downloadRecords.slice(0, MIN_PERSISTED_DOWNLOAD_RECORDS)
        removed = true
      }
    }
    trim(this.persisted.guest)
    Object.values(this.persisted.accounts).forEach(trim)
    if (removed) this.rebuildState()
    return removed
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
    // 损坏的草稿整份丢弃：作品记录还在，打开时走「缺少可恢复的网格数据」提示，
    // 比留一份空白画布让用户以为自己画的东西没了要好
    currentDraft: w.currentDraft ? normalizeDraft(w.currentDraft) : null,
    localDrafts: Object.fromEntries(
      Object.entries(w.localDrafts ?? {})
        .map(([id, draft]) => [id, normalizeDraft(draft)] as const)
        .filter((entry): entry is [string, PatternDraft] => entry[1] !== null),
    ),
    works: (w.works ?? []).map(normalizeWork),
    favoriteIds: w.favoriteIds ?? [],
    downloadRecords: w.downloadRecords ?? [],
  }
}
function normalizePersistedState(state: PersistedState): PersistedState { return { version: 2, guest: normalizeWorkspace(state.guest), accounts: Object.fromEntries(Object.entries(state.accounts ?? {}).map(([id, w]) => [id, normalizeWorkspace(w)])) } }
function isPersistedState(value: unknown): value is PersistedState { return typeof value === 'object' && value !== null && (value as { version?: unknown }).version === 2 && typeof (value as { guest?: unknown }).guest === 'object' }
function isSynced(work: WorkItem): boolean { return work.syncStatus === 'synced' || work.isCloud === true }

/**
 * 兼容两种落盘形态：新版是「调色板 + 下标」（cells 首元素为 number），旧版是逐格对象。
 * 旧数据无需迁移 —— 读回来展开即可，下一次写入自然变成压缩格式。
 * @returns 编辑态草稿；压缩态但调色板/下标对不上（数据已损坏）时返回 null，由调用方丢弃
 */
function restoreDraftCells(draft: PatternDraft): PatternDraft | null {
  const packed = draft as unknown as CompactDraft
  if (!Array.isArray(packed.cells) || typeof packed.cells[0] !== 'number') return draft
  const cells = decodePatternCells(packed)
  if (!cells) {
    // 压缩态但调色板/下标对不上：数据已损坏，返回 null 让调用方整份丢弃。
    // 这里不能降级成 cells: [] —— 空数组是一份「合法的空白画布」，编辑器会照常打开，
    // 用户既看不到任何异常提示，又会在保存后把空白网格写回去覆盖掉原本可诊断的现场。
    console.warn('本机草稿网格数据已损坏，已丢弃', draft.id)
    return null
  }
  // 可选字段未经内容安全检查时不存在，这里保持「要么有值要么不出现」，避免写出一堆 undefined
  return {
    id: packed.id,
    sourceImagePath: packed.sourceImagePath,
    ...(packed.contentSecurityCheckId === undefined ? {} : { contentSecurityCheckId: packed.contentSecurityCheckId }),
    ...(packed.contentSecurityImagePath === undefined ? {} : { contentSecurityImagePath: packed.contentSecurityImagePath }),
    ...(packed.creationSource === undefined ? {} : { creationSource: packed.creationSource }),
    ...(packed.sourcePrompt === undefined ? {} : { sourcePrompt: packed.sourcePrompt }),
    createdAt: packed.createdAt,
    generationMode: packed.generationMode,
    settings: packed.settings,
    cells,
  }
}

/**
 * 归一化单份草稿：还原网格 + 补齐生成模式。
 * @returns 归一化后的草稿；网格数据损坏无法还原时返回 null，由调用方整份丢弃
 */
function normalizeDraft(draft: PatternDraft): PatternDraft | null {
  const restored = restoreDraftCells(draft)
  if (!restored) return null
  return { ...restored, generationMode: isGenerationMode(restored.generationMode) ? restored.generationMode : (restored.id.startsWith('ai-pending-') ? 'ai' : 'standard') }
}
function normalizeWork(work: WorkItem): WorkItem { return { ...work, generationMode: isGenerationMode(work.generationMode) ? work.generationMode : 'standard' } }
function mergeWorks(first: WorkItem[], second: WorkItem[]): WorkItem[] { const seen = new Set<string>(); return [...first, ...second].filter((work) => !seen.has(work.id) && (seen.add(work.id), true)) }
function applyFavorite(works: WorkItem[], id: string, favorite: boolean, at: number): WorkItem[] { return works.map((work) => work.id === id ? { ...work, isFavorite: favorite, favoritedAt: favorite ? at : undefined } : work) }
function unique(values: string[]): string[] { return [...new Set(values)] }
function dateKey(): string { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function normalizeQuota(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DAILY_FREE_DOWNLOAD_QUOTA }

function writeStorage(payload: StoredPersistedState): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    wx.setStorage({ key: STORAGE_KEY, data: payload, success: () => resolve(), fail: (error) => reject(error) })
  })
}

/** 把运行态压成落盘态：草稿网格压缩，并按上限裁掉最旧的草稿与下载记录。 */
function encodePersistedState(state: PersistedState): StoredPersistedState {
  return {
    version: state.version,
    guest: encodeWorkspace(state.guest),
    accounts: Object.fromEntries(Object.entries(state.accounts).map(([id, workspace]) => [id, encodeWorkspace(workspace)])),
  }
}

function encodeWorkspace(workspace: Workspace): StoredWorkspace {
  return {
    ...workspace,
    currentDraft: workspace.currentDraft ? encodeDraft(workspace.currentDraft) : null,
    localDrafts: Object.fromEntries(
      Object.entries(limitDrafts(workspace.localDrafts, workspace.currentDraft?.id, MAX_PERSISTED_DRAFTS))
        .map(([id, draft]) => [id, encodeDraft(draft)]),
    ),
    // 常态按 MAX 裁；自救（shrink）已经把运行态裁到 MIN，这里再裁一次也不会复活被丢掉的条目
    downloadRecords: workspace.downloadRecords.slice(0, MAX_PERSISTED_DOWNLOAD_RECORDS),
  }
}

function encodeDraft(draft: PatternDraft): CompactDraft {
  const packed = encodePatternCells(draft.cells)
  return {
    id: draft.id,
    sourceImagePath: draft.sourceImagePath,
    // 与 restoreDraftCells 对称：可选字段要么有值要么不出现，不写 undefined 占位键
    ...(draft.contentSecurityCheckId === undefined ? {} : { contentSecurityCheckId: draft.contentSecurityCheckId }),
    ...(draft.contentSecurityImagePath === undefined ? {} : { contentSecurityImagePath: draft.contentSecurityImagePath }),
    ...(draft.creationSource === undefined ? {} : { creationSource: draft.creationSource }),
    ...(draft.sourcePrompt === undefined ? {} : { sourcePrompt: draft.sourcePrompt }),
    createdAt: draft.createdAt,
    generationMode: draft.generationMode,
    settings: draft.settings,
    palette: packed.palette,
    cells: packed.cells,
  }
}

/**
 * 草稿条数裁剪：按 createdAt **降序**（最新的在前）保留 limit 份，其余（更旧的）丢弃。
 * 当前草稿（keepId）不计入 limit，始终保留 —— 它正被编辑，丢掉等于丢用户手上的活。
 */
function limitDrafts(drafts: Record<string, PatternDraft>, keepId: string | undefined, limit: number): Record<string, PatternDraft> {
  const entries = Object.entries(drafts)
  if (entries.length <= limit) return drafts
  const kept: Record<string, PatternDraft> = {}
  let count = 0
  for (const [id, draft] of [...entries].sort((a, b) => b[1].createdAt - a[1].createdAt)) {
    if (id !== keepId && count >= limit) continue
    kept[id] = draft
    count += 1
  }
  return kept
}

function errMsgOf(error: unknown): string {
  return typeof (error as { errMsg?: unknown })?.errMsg === 'string' ? (error as { errMsg: string }).errMsg : ''
}
/** 微信 storage 写失败只区分「配额写满」与「其它」；前者值得自救，后者重试无意义。 */
function isStorageQuotaError(error: unknown): boolean { return /exceed|limit|quota|max size/i.test(errMsgOf(error)) }
function storageMessage(error: unknown): string { return isStorageQuotaError(error) ? '本机存储空间不足，请清理空间后重试' : '本机保存失败，请稍后重试' }
