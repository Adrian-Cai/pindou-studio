import type { PatternDraft, WorkItem } from '../models/pattern'
import { appStore } from '../store/app-store'
import { checkImageContent } from './content-security-service'
import { prepareImageForContentSecurity } from './image-service'
import { cloudSummaryToWorkItem, hasCloudSession, saveNewCloudWork, setCloudFavorite } from './work-service'
import { ApiError } from './http-client'

export interface WorkSyncResult { uploaded: number; skipped: number; failed: number }
let syncTask: Promise<WorkSyncResult> | null = null

/** 逐个同步；创建接口用 draft id 作为幂等键，网络恢复后不会重复创建作品。 */
export function syncPendingWorks(userId: string): Promise<WorkSyncResult> {
  if (syncTask) return syncTask
  syncTask = performSync(userId).finally(() => { syncTask = null })
  return syncTask
}

async function performSync(userId: string): Promise<WorkSyncResult> {
  if (!hasCloudSession() || appStore.getActiveUserId() !== userId) return { uploaded: 0, skipped: 0, failed: 0 }
  let uploaded = 0; let skipped = 0; let failed = 0
  for (const work of appStore.getSyncCandidates(userId)) {
    const draft = appStore.getLocalDraft(work.id)
    if (!draft) { await appStore.markSyncStatus(work.id, 'failed', '作品图案数据不完整，请重新编辑后重试'); skipped += 1; continue }
    try {
      await appStore.markSyncStatus(work.id, 'pending')
      await checkImageContent(await prepareImageForContentSecurity(work.coverPath))
      const summary = await saveNewCloudWork(draft, work.coverPath, work.title)
      const favorite = appStore.getSnapshot().favoriteIds.includes(work.id) ? await setCloudFavorite(summary.id, true) : null
      await appStore.replaceLocalWorkWithCloud(work.id, {
        ...cloudSummaryToWorkItem(summary),
        isFavorite: favorite?.isFavorite ?? summary.isFavorite,
        ...(favorite?.favoritedAt ? { favoritedAt: Date.parse(favorite.favoritedAt) } : {}),
      })
      uploaded += 1
    } catch (error) {
      await appStore.markSyncStatus(work.id, isNetworkError(error) ? 'pending' : 'failed', syncErrorMessage(error))
      failed += 1
    }
  }
  return { uploaded, skipped, failed }
}

export async function queueWorkForSync(work: WorkItem, draft: PatternDraft): Promise<void> {
  await appStore.saveLocalDraft(draft)
  await appStore.saveWork({ ...work, syncStatus: work.syncStatus ?? 'pending', isCloud: false })
}

export function isNetworkError(error: unknown): boolean { return error instanceof ApiError && (error.code === 'NETWORK_ERROR' || error.statusCode === 0) }
function syncErrorMessage(error: unknown): string { return isNetworkError(error) ? '网络不可用，联网后会自动继续同步' : error instanceof Error ? error.message : '同步失败，请稍后重试' }
