import type {
  DownloadRecord,
  PatternDraft,
  PrivacyPreferences,
  WorkItem,
} from '../models/pattern'

interface AppState {
  currentDraft: PatternDraft | null
  localDrafts: Record<string, PatternDraft>
  works: WorkItem[]
  favoriteIds: string[]
  downloadQuota: number
  downloadQuotaDate: string
  downloadRecords: DownloadRecord[]
  privacyPreferences: PrivacyPreferences
}

const STORAGE_KEY = 'pindou-app-state-v1'
const DAILY_FREE_DOWNLOAD_QUOTA = 9

const initialState: AppState = {
  currentDraft: null,
  localDrafts: {},
  works: [],
  favoriteIds: [],
  downloadQuota: DAILY_FREE_DOWNLOAD_QUOTA,
  downloadQuotaDate: '',
  downloadRecords: [],
  privacyPreferences: {
    localOnly: true,
    cloudSync: false,
    serviceNotices: true,
    personalizedRecommendations: false,
  },
}

type Listener = (state: Readonly<AppState>) => void

export class AppStore {
  private state: AppState = createInitialState()
  private listeners = new Set<Listener>()

  hydrate() {
    try {
      const cached = wx.getStorageSync<AppState>(STORAGE_KEY)
      if (cached) {
        const today = getLocalBusinessDate()
        const localDrafts = { ...(cached.localDrafts ?? {}) }
        const currentWork = cached.works?.find((work) => work.id === cached.currentDraft?.id)
        if (cached.currentDraft && currentWork && !currentWork.isCloud) {
          localDrafts[cached.currentDraft.id] = cached.currentDraft
        }
        this.state = {
          ...createInitialState(),
          ...cached,
          localDrafts,
          downloadQuota: cached.downloadQuotaDate === today
            ? normalizeQuota(cached.downloadQuota)
            : DAILY_FREE_DOWNLOAD_QUOTA,
          downloadQuotaDate: today,
          privacyPreferences: {
            ...normalizePrivacyPreferences({
              ...initialState.privacyPreferences,
              ...cached.privacyPreferences,
            }),
          },
        }
      }
    } catch (error) {
      console.warn('读取本地状态失败', error)
    }
  }

  getSnapshot(): Readonly<AppState> {
    return this.state
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  setCurrentDraft(currentDraft: PatternDraft | null) {
    this.update({ currentDraft })
  }

  saveLocalDraft(draft: PatternDraft) {
    this.update({
      localDrafts: { ...this.state.localDrafts, [draft.id]: draft },
    })
  }

  getLocalDraft(workId: string): PatternDraft | null {
    return this.state.localDrafts[workId] ?? null
  }

  removeLocalDraft(workId: string) {
    if (!this.state.localDrafts[workId]) return
    const localDrafts = { ...this.state.localDrafts }
    delete localDrafts[workId]
    this.update({ localDrafts })
  }

  saveWork(work: WorkItem) {
    const works = [work, ...this.state.works.filter((item) => item.id !== work.id)]
    this.update({ works })
  }

  replaceLocalWorkWithCloud(localWorkId: string, cloudWork: WorkItem) {
    const works = [
      cloudWork,
      ...this.state.works.filter((item) => item.id !== localWorkId && item.id !== cloudWork.id),
    ]
    const favoriteIds = [...new Set(this.state.favoriteIds.map((id) => (
      id === localWorkId ? cloudWork.id : id
    )))]
    const downloadRecords = this.state.downloadRecords.map((record) => (
      record.workId === localWorkId ? { ...record, workId: cloudWork.id } : record
    ))
    const currentDraft = this.state.currentDraft?.id === localWorkId
      ? { ...this.state.currentDraft, id: cloudWork.id, sourceImagePath: '' }
      : this.state.currentDraft
    const localDrafts = { ...this.state.localDrafts }
    delete localDrafts[localWorkId]
    this.update({ works, favoriteIds, downloadRecords, currentDraft, localDrafts })
  }

  replaceCloudWorks(cloudWorks: WorkItem[]) {
    const localWorks = this.state.works.filter((item) => !item.isCloud)
    this.update({ works: [...cloudWorks, ...localWorks] })
  }

  toggleFavorite(workId: string) {
    const exists = this.state.favoriteIds.includes(workId)
    const favoriteIds = exists
      ? this.state.favoriteIds.filter((id) => id !== workId)
      : [...this.state.favoriteIds, workId]
    this.update({ favoriteIds })
  }

  deleteWork(workId: string) {
    const works = this.state.works.filter((item) => item.id !== workId)
    const favoriteIds = this.state.favoriteIds.filter((id) => id !== workId)
    const downloadRecords = this.state.downloadRecords.filter((item) => item.workId !== workId)
    const currentDraft = this.state.currentDraft?.id === workId ? null : this.state.currentDraft
    const localDrafts = { ...this.state.localDrafts }
    delete localDrafts[workId]
    this.update({ works, favoriteIds, downloadRecords, currentDraft, localDrafts })
  }

  addDownloadRecord(record: DownloadRecord) {
    const downloadRecords = [
      record,
      ...this.state.downloadRecords.filter((item) => item.id !== record.id),
    ]
    this.update({ downloadRecords })
  }

  setDownloadQuota(downloadQuota: number) {
    this.update({
      downloadQuota: normalizeQuota(downloadQuota),
      downloadQuotaDate: getLocalBusinessDate(),
    })
  }

  refreshDownloadQuota(): number {
    const today = getLocalBusinessDate()
    if (this.state.downloadQuotaDate !== today) {
      this.update({
        downloadQuota: DAILY_FREE_DOWNLOAD_QUOTA,
        downloadQuotaDate: today,
      })
    }
    return this.state.downloadQuota
  }

  completeDownload(record: DownloadRecord): number | null {
    this.refreshDownloadQuota()
    if (this.state.downloadQuota <= 0) return null
    const downloadQuota = this.state.downloadQuota - 1
    const downloadRecords = [
      record,
      ...this.state.downloadRecords.filter((item) => item.id !== record.id),
    ]
    this.update({ downloadQuota, downloadRecords })
    return downloadQuota
  }

  setPrivacyPreferences(patch: Partial<PrivacyPreferences>) {
    this.update({
      privacyPreferences: normalizePrivacyPreferences({
        ...this.state.privacyPreferences,
        ...patch,
      }),
    })
  }

  clearLocalData() {
    this.state = createInitialState()
    try {
      wx.removeStorageSync(STORAGE_KEY)
    } catch (error) {
      console.warn('清除本地状态失败', error)
    }
    this.listeners.forEach((listener) => listener(this.state))
  }

  private update(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch }
    wx.setStorage({ key: STORAGE_KEY, data: this.state })
    this.listeners.forEach((listener) => listener(this.state))
  }
}

export const appStore = new AppStore()

function createInitialState(): AppState {
  return {
    ...initialState,
    localDrafts: {},
    works: [],
    favoriteIds: [],
    downloadQuotaDate: getLocalBusinessDate(),
    downloadRecords: [],
    privacyPreferences: { ...initialState.privacyPreferences },
  }
}

function normalizePrivacyPreferences(value: PrivacyPreferences): PrivacyPreferences {
  if (value.cloudSync) return { ...value, localOnly: false }
  if (value.localOnly) return { ...value, cloudSync: false }
  return value
}

function getLocalBusinessDate(): string {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function normalizeQuota(value: number): number {
  if (!Number.isFinite(value)) return DAILY_FREE_DOWNLOAD_QUOTA
  return Math.max(0, Math.floor(value))
}
