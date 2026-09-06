import type { PrivacyPreferences } from '../models/pattern'

export function parsePrivacyPreferences(value: unknown): PrivacyPreferences | null {
  if (!isRecord(value)) return null
  if (
    typeof value.localOnly !== 'boolean'
    || typeof value.cloudSync !== 'boolean'
    || typeof value.serviceNotices !== 'boolean'
    || typeof value.personalizedRecommendations !== 'boolean'
  ) return null
  if (value.updatedAt !== undefined && typeof value.updatedAt !== 'string') return null
  return {
    localOnly: value.localOnly,
    cloudSync: value.cloudSync,
    serviceNotices: value.serviceNotices,
    personalizedRecommendations: value.personalizedRecommendations,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
