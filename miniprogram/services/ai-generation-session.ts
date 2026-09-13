import type { PatternSettings } from '../models/pattern'
import type {
  AiGenerationBackgroundMode,
  AiGenerationDetailLevel,
  AiGenerationStyle,
} from './ai-generation-service'

export interface AiGenerationSession {
  idempotencyKey: string
  generationMode: 'ai'
  jobId: string | null
  inputFileId: string | null
  sourceImagePath: string
  outputImagePath: string
  settings: PatternSettings
  style: AiGenerationStyle
  detailLevel: AiGenerationDetailLevel
  backgroundMode: AiGenerationBackgroundMode
  status: 'uploading' | 'creating' | 'processing' | 'succeeded' | 'failed'
  createdAt: number
}

export const AI_GENERATION_SESSION_STORAGE_KEY = 'pindou-ai-generation-session-v1'

export function createIdempotencyKey(): string {
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

export function saveAiGenerationSession(session: AiGenerationSession): void {
  wx.setStorageSync(AI_GENERATION_SESSION_STORAGE_KEY, session)
}

export function loadAiGenerationSession(): AiGenerationSession | null {
  try {
    const value = wx.getStorageSync<unknown>(AI_GENERATION_SESSION_STORAGE_KEY)
    if (!isAiGenerationSession(value)) return null
    return { ...value, generationMode: 'ai' }
  } catch (error) {
    console.warn('读取 AI 任务会话失败', error)
    return null
  }
}

export function clearAiGenerationSession(): void {
  try {
    wx.removeStorageSync(AI_GENERATION_SESSION_STORAGE_KEY)
  } catch (error) {
    console.warn('清理 AI 任务会话失败', error)
  }
}

function isAiGenerationSession(value: unknown): value is AiGenerationSession {
  if (!isRecord(value)) return false
  return (
    nonEmptyString(value.idempotencyKey)
    && (value.generationMode === undefined || value.generationMode === 'ai')
    && isNullableNonEmptyString(value.jobId)
    && isNullableNonEmptyString(value.inputFileId)
    && nonEmptyString(value.sourceImagePath)
    && typeof value.outputImagePath === 'string'
    && isPatternSettings(value.settings)
    && isStyle(value.style)
    && isDetailLevel(value.detailLevel)
    && isBackgroundMode(value.backgroundMode)
    && isSessionStatus(value.status)
    && typeof value.createdAt === 'number'
    && Number.isFinite(value.createdAt)
  )
}

function isPatternSettings(value: unknown): value is PatternSettings {
  if (!isRecord(value)) return false
  return (
    isPositiveInteger(value.width)
    && isPositiveInteger(value.height)
    && isPositiveInteger(value.colorLimit)
    && nonEmptyString(value.brand)
  )
}

function isSessionStatus(value: unknown): value is AiGenerationSession['status'] {
  return value === 'uploading'
    || value === 'creating'
    || value === 'processing'
    || value === 'succeeded'
    || value === 'failed'
}

function isStyle(value: unknown): value is AiGenerationStyle {
  return value === 'natural' || value === 'cartoon' || value === 'minimal'
}

function isDetailLevel(value: unknown): value is AiGenerationDetailLevel {
  return value === 'low' || value === 'medium' || value === 'high'
}

function isBackgroundMode(value: unknown): value is AiGenerationBackgroundMode {
  return value === 'keep' || value === 'simplify' || value === 'remove'
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || nonEmptyString(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
