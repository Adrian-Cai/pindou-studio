import type { PatternDraft, WorkItem } from '../models/pattern'
import { appStore } from '../store/app-store'
import {
  cloudSummaryToWorkItem,
  hasCloudSession,
  saveNewCloudWork,
} from './work-service'
import { checkImageContent } from './content-security-service'

export interface LocalWorkSyncResult {
  uploaded: number
  skipped: number
  failed: number
}

export async function syncLocalWorksToCloud(): Promise<LocalWorkSyncResult> {
  if (!hasCloudSession() || !appStore.getSnapshot().privacyPreferences.cloudSync) {
    return { uploaded: 0, skipped: 0, failed: 0 }
  }

  const state = appStore.getSnapshot()
  const localWorks = state.works.filter((work) => !work.isCloud)
  let uploaded = 0
  let skipped = 0
  let failed = 0

  for (const work of localWorks) {
    const draft = getDraftForWork(work, state.currentDraft)
    if (!draft) {
      skipped += 1
      console.warn('本地作品缺少可同步的图案数据', { workId: work.id })
      continue
    }

    try {
      await checkImageContent(work.coverPath)
      const summary = await saveNewCloudWork(draft, work.coverPath, work.title)
      appStore.replaceLocalWorkWithCloud(work.id, cloudSummaryToWorkItem(summary))
      uploaded += 1
    } catch (error) {
      failed += 1
      console.error('同步本地作品失败', { workId: work.id, error })
    }
  }

  return { uploaded, skipped, failed }
}

function getDraftForWork(
  work: WorkItem,
  currentDraft: PatternDraft | null,
): PatternDraft | null {
  return appStore.getLocalDraft(work.id)
    ?? (currentDraft?.id === work.id ? currentDraft : null)
}
