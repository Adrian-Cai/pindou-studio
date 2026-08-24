import type { PatternDraft, WorkItem } from '../models/pattern'

interface AppState {
  currentDraft: PatternDraft | null
  works: WorkItem[]
  favoriteIds: string[]
  downloadQuota: number
}

const STORAGE_KEY = 'pindou-app-state-v1'

const initialState: AppState = {
  currentDraft: null,
  works: [],
  favoriteIds: [],
  downloadQuota: 3,
}

type Listener = (state: Readonly<AppState>) => void

export class AppStore {
  private state: AppState = { ...initialState }
  private listeners = new Set<Listener>()

  hydrate() {
    try {
      const cached = wx.getStorageSync<AppState>(STORAGE_KEY)
      if (cached) this.state = { ...initialState, ...cached }
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

  toggleFavorite(workId: string) {
    const exists = this.state.favoriteIds.includes(workId)
    const favoriteIds = exists
      ? this.state.favoriteIds.filter((id) => id !== workId)
      : [...this.state.favoriteIds, workId]
    this.update({ favoriteIds })
  }

  private update(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch }
    wx.setStorage({ key: STORAGE_KEY, data: this.state })
    this.listeners.forEach((listener) => listener(this.state))
  }
}

export const appStore = new AppStore()
