import type {
  DownloadRecord,
  PatternDraft,
  PrivacyPreferences,
  WorkItem,
} from '../models/pattern'

interface AppState {
  currentDraft: PatternDraft | null
  works: WorkItem[]
  favoriteIds: string[]
  downloadQuota: number
  downloadRecords: DownloadRecord[]
  privacyPreferences: PrivacyPreferences
}

const STORAGE_KEY = 'pindou-app-state-v1'

const initialState: AppState = {
  currentDraft: null,
  works: [],
  favoriteIds: [],
  downloadQuota: 3,
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
        this.state = {
          ...createInitialState(),
          ...cached,
          privacyPreferences: {
            ...initialState.privacyPreferences,
            ...cached.privacyPreferences,
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

  saveWork(work: WorkItem) {
    const works = [work, ...this.state.works.filter((item) => item.id !== work.id)]
    this.update({ works })
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
    this.update({ works, favoriteIds, downloadRecords, currentDraft })
  }

  addDownloadRecord(record: DownloadRecord) {
    const downloadRecords = [
      record,
      ...this.state.downloadRecords.filter((item) => item.id !== record.id),
    ]
    this.update({ downloadRecords })
  }

  setPrivacyPreferences(patch: Partial<PrivacyPreferences>) {
    this.update({
      privacyPreferences: { ...this.state.privacyPreferences, ...patch },
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
    works: [],
    favoriteIds: [],
    downloadRecords: [],
    privacyPreferences: { ...initialState.privacyPreferences },
  }
}
