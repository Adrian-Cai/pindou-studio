/**
 * AI 生成任务的本地持久化（Storage 封装，数组结构）。
 *
 * 职责：以任务数组（而非单例对象）保存每一条 AI 生成任务的状态、文件、参数与失败信息，
 *       提供创建/读取/局部更新/删除/清理能力；负责把旧版单例 session 迁移成任务记录。
 * 调用方：ai-generation-manager（唯一驱动方）、ai-generation-flow（只读改自己那一条）。
 * 关键点：storage key 固定版本号 v1；读写都做结构校验，脏数据按条丢弃而不是让整个数组失效；
 *       所有写入必须只改动目标那一条（patchAiTask），禁止整体覆盖数组——这是旧方案把并发任务冲掉的根源。
 */
import type { PatternSettings } from '../models/pattern'
import type {
  AiGenerationBackgroundMode,
  AiGenerationDetailLevel,
  AiGenerationFailure,
  AiGenerationStyle,
} from './ai-generation-service'

/** 一条 AI 任务从入队到出结果的完整生命周期；succeeded / failed 为终态。 */
export type AiTaskStatus =
  | 'created'
  | 'uploading'
  | 'submitting'
  | 'queued'
  | 'processing'
  | 'downloading'
  | 'converting'
  | 'succeeded'
  | 'failed'

/** 展示用进度（服务端无精确百分比，沿用原有按阶段估算的策略）。 */
export const PHASE_PROGRESS: Record<AiTaskStatus, number> = {
  created: 5,
  uploading: 12,
  submitting: 28,
  queued: 45,
  processing: 68,
  downloading: 86,
  converting: 94,
  succeeded: 100,
  failed: 100,
}

export interface AiTask {
  /** 本地唯一 ID，同时作为作品 ID（taskId === workId） */
  taskId: string
  status: AiTaskStatus
  /** 服务端任务 ID，创建成功后才有 */
  jobId: string | null
  /** 已上传的输入文件 ID，重试时可复用，避免重复上传 */
  inputFileId: string | null
  idempotencyKey: string
  securityCheckId?: string
  /** 已永久化的原图路径 */
  sourceImagePath: string
  /** 已永久化的内容安全检测压缩图路径 */
  inputImagePath?: string
  /** AI 输出图本地路径 */
  outputImagePath: string
  settings: PatternSettings
  style: AiGenerationStyle
  detailLevel: AiGenerationDetailLevel
  backgroundMode: AiGenerationBackgroundMode
  failure: AiGenerationFailure | null
  retryCount: number
  createdAt: number
  updatedAt: number
  /** 进入远端处理的时间，用于超时判定 */
  startedAt: number | null
  finishedAt: number | null
}

export interface CreateAiTaskInput {
  sourceImagePath: string
  inputImagePath?: string
  securityCheckId?: string
  settings: PatternSettings
  style?: AiGenerationStyle
  detailLevel?: AiGenerationDetailLevel
  backgroundMode?: AiGenerationBackgroundMode
}

const AI_TASK_STORAGE_KEY = 'pindou-ai-tasks-v1'
const AI_TASK_MIGRATED_KEY = 'pindou-ai-tasks-migrated-v1'
/** 旧版单例会话的 key，迁移完成后不再读写 */
const LEGACY_SESSION_STORAGE_KEY = 'pindou-ai-generation-session-v1'
/** 任务数组上限，超出后淘汰最老的终态任务 */
const MAX_TASKS = 20
/** 终态任务保留时长 */
const TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 永久化图片的存放目录名（相对 wx.env.USER_DATA_PATH） */
export const AI_IMAGE_DIRECTORY = 'pindou-ai'

/** 永久化图片目录的绝对路径。 */
export function aiImageDirectoryPath(): string {
  return `${wx.env.USER_DATA_PATH}/${AI_IMAGE_DIRECTORY}`
}

/** 生成幂等键，格式 ai-<时间戳>-<随机串>，用于服务端防重复建单。 */
export function createIdempotencyKey(): string {
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

export function createTaskId(): string {
  return `ai-task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function isAiTaskTerminal(status: AiTaskStatus): boolean {
  return status === 'succeeded' || status === 'failed'
}

export function listAiTasks(): AiTask[] {
  return readTasks()
}

export function getAiTask(taskId: string): AiTask | null {
  if (!taskId) return null
  return readTasks().find((task) => task.taskId === taskId) ?? null
}

/** 非终态任务，按 createdAt 升序（先来的先跑）。 */
export function listActiveAiTasks(): AiTask[] {
  return readTasks()
    .filter((task) => !isAiTaskTerminal(task.status))
    .sort((left, right) => left.createdAt - right.createdAt)
}

export function listTerminalAiTasks(): AiTask[] {
  return readTasks().filter((task) => isAiTaskTerminal(task.status))
}

export function createAiTask(input: CreateAiTaskInput): AiTask {
  const now = Date.now()
  const task: AiTask = {
    taskId: createTaskId(),
    status: 'created',
    jobId: null,
    inputFileId: null,
    idempotencyKey: createIdempotencyKey(),
    securityCheckId: input.securityCheckId?.trim() || undefined,
    sourceImagePath: input.sourceImagePath,
    inputImagePath: input.inputImagePath?.trim() || undefined,
    outputImagePath: '',
    settings: { ...input.settings },
    style: input.style ?? 'natural',
    detailLevel: input.detailLevel ?? 'medium',
    backgroundMode: input.backgroundMode ?? 'simplify',
    failure: null,
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  }
  const tasks = readTasks()
  tasks.push(task)
  writeTasks(tasks)
  return task
}

/**
 * 只更新目标任务的字段，其余任务原样保留。
 * @returns 更新后的任务；任务不存在时返回 null
 */
export function patchAiTask(taskId: string, patch: Partial<AiTask>): AiTask | null {
  const tasks = readTasks()
  const index = tasks.findIndex((task) => task.taskId === taskId)
  if (index < 0) return null
  const next: AiTask = {
    ...tasks[index],
    ...patch,
    taskId,
    updatedAt: patch.updatedAt ?? Date.now(),
  }
  const nextTasks = [...tasks]
  nextTasks[index] = next
  writeTasks(nextTasks)
  return next
}

export function removeAiTask(taskId: string): void {
  const tasks = readTasks()
  const next = tasks.filter((task) => task.taskId !== taskId)
  if (next.length === tasks.length) return
  writeTasks(next)
}

/** 清理过期与超量的终态任务；非终态任务一律保留。 */
export function pruneAiTasks(): void {
  const now = Date.now()
  let tasks = readTasks()
  const expiredIds = new Set(
    tasks
      // 终态任务的保留期从「完成时刻」起算，不是创建时刻：
      // 用 createdAt 的话，一个很早提交、刚刚才跑完的任务会因为创建时间超期被立刻清掉，
      // 用户还没来得及看结果卡片就没了。finishedAt 在终态下必定有值，createdAt 只是兜底。
      .filter((task) => isAiTaskTerminal(task.status) && now - (task.finishedAt ?? task.createdAt) > TERMINAL_TTL_MS)
      .map((task) => task.taskId),
  )
  tasks = tasks.filter((task) => !expiredIds.has(task.taskId))

  const overflow = tasks.length - MAX_TASKS
  if (overflow > 0) {
    const terminalOldestFirst = tasks
      .filter((task) => isAiTaskTerminal(task.status))
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, overflow)
      .map((task) => task.taskId)
    const droppable = new Set(terminalOldestFirst)
    tasks = tasks.filter((task) => !droppable.has(task.taskId))
  }
  writeTasks(tasks)
}

/**
 * 清理永久化图片目录里的孤儿文件：任务记录已删、但图片还留在磁盘上的那些。
 * 只删「没有任何任务引用」且「文件名时间戳已超过 TERMINAL_TTL_MS」的文件——
 * 刚写入、还来不及被任何任务引用的文件不会误删。
 * 调用方：AiTaskManager.init()（每次冷启动跑一次，失败不影响启动）。
 */
export function pruneAiTaskImages(): void {
  const directory = aiImageDirectoryPath()
  const referenced = new Set<string>()
  for (const task of readTasks()) {
    referenced.add(task.sourceImagePath)
    if (task.inputImagePath) referenced.add(task.inputImagePath)
    if (task.outputImagePath) referenced.add(task.outputImagePath)
  }

  let entries: string[]
  try {
    entries = wx.getFileSystemManager().readdirSync(directory)
  } catch {
    // 目录不存在（还没永久化过任何图）或不可读，本次跳过
    return
  }

  const deadline = Date.now() - TERMINAL_TTL_MS
  for (const name of entries) {
    const filePath = `${directory}/${name}`
    if (referenced.has(filePath)) continue
    // 文件名格式 <时间戳>-<随机串><扩展名>，时间戳缺失或仍在有效期内都不动
    const createdAt = Number.parseInt(name.split('-')[0] ?? '', 10)
    if (!Number.isFinite(createdAt) || createdAt <= 0 || createdAt > deadline) continue
    try {
      wx.getFileSystemManager().unlinkSync(filePath)
    } catch {
      // 删不掉就下次再试，不影响启动
    }
  }
}

/** 本地文件是否仍然存在（临时文件路径在 App 重启后会失效）。 */
export function isFilePathAlive(filePath: string): boolean {
  if (!filePath.trim()) return false
  try {
    wx.getFileSystemManager().accessSync(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 把旧版单例会话迁移成任务记录，只执行一次（用 migrated 标记位兜底）。
 * 终态旧会话不迁移——用户已经看到结果或已经放弃，凭空造一张卡片是噪声。
 * @returns 迁移得到的新任务 ID，无需迁移或迁移失败时返回 null
 */
export function migrateLegacyAiSession(): string | null {
  if (readMigrationFlag()) return null
  const legacy = loadLegacySession()
  // 没有旧会话、或旧会话已终态：都算「没什么要迁的」，标记后收工
  if (!legacy || legacy.status === 'succeeded' || legacy.status === 'failed') {
    markMigrated()
    if (legacy) removeLegacySession()
    return null
  }

  // 顺序很关键：**先建新任务，再删旧会话，最后才打迁移标记**。
  // 反过来（先标记 + 先删旧会话）的话，建任务途中崩溃就是
  // 「旧数据没了、新任务没建成、标记还挡着下次重试」—— 用户的在跑任务静默丢失。
  let migrated: ReturnType<typeof createAiTask>
  try {
    migrated = createAiTask({
      sourceImagePath: legacy.sourceImagePath,
      inputImagePath: legacy.inputImagePath,
      securityCheckId: legacy.securityCheckId,
      settings: legacy.settings,
      style: legacy.style,
      detailLevel: legacy.detailLevel,
      backgroundMode: legacy.backgroundMode,
    })
    const status: AiTaskStatus = legacy.jobId ? 'processing' : 'created'
    patchAiTask(migrated.taskId, {
      status,
      jobId: legacy.jobId,
      inputFileId: legacy.inputFileId,
      idempotencyKey: legacy.idempotencyKey,
      outputImagePath: legacy.outputImagePath,
      startedAt: legacy.jobId ? Date.now() : null,
      createdAt: legacy.createdAt,
    })
  } catch (error) {
    // 建任务失败：旧会话和未标记状态都留着，下次冷启动还能再迁一次
    console.warn('迁移旧版 AI 会话失败，保留原会话等待下次重试', error)
    return null
  }
  removeLegacySession()
  markMigrated()
  return migrated.taskId
}

function readTasks(): AiTask[] {
  try {
    const value = wx.getStorageSync<unknown>(AI_TASK_STORAGE_KEY)
    if (!Array.isArray(value)) return []
    return value.filter(isAiTask)
  } catch (error) {
    console.warn('读取 AI 任务列表失败', error)
    return []
  }
}

function writeTasks(tasks: AiTask[]): void {
  try {
    wx.setStorageSync(AI_TASK_STORAGE_KEY, tasks)
  } catch (error) {
    console.error('写入 AI 任务列表失败', error)
  }
}

function loadLegacySession(): {
  sourceImagePath: string
  inputImagePath?: string
  securityCheckId?: string
  outputImagePath: string
  settings: PatternSettings
  style: AiGenerationStyle
  detailLevel: AiGenerationDetailLevel
  backgroundMode: AiGenerationBackgroundMode
  jobId: string | null
  inputFileId: string | null
  idempotencyKey: string
  createdAt: number
  status: string
} | null {
  try {
    const value = wx.getStorageSync<unknown>(LEGACY_SESSION_STORAGE_KEY)
    if (!isRecord(value)) return null
    if (typeof value.sourceImagePath !== 'string' || !value.sourceImagePath.trim()) return null
    if (!isPatternSettings(value.settings)) return null
    return {
      sourceImagePath: value.sourceImagePath,
      inputImagePath: typeof value.inputImagePath === 'string' ? value.inputImagePath : undefined,
      securityCheckId: typeof value.securityCheckId === 'string' ? value.securityCheckId : undefined,
      outputImagePath: typeof value.outputImagePath === 'string' ? value.outputImagePath : '',
      settings: value.settings,
      style: isStyle(value.style) ? value.style : 'natural',
      detailLevel: isDetailLevel(value.detailLevel) ? value.detailLevel : 'medium',
      backgroundMode: isBackgroundMode(value.backgroundMode) ? value.backgroundMode : 'simplify',
      jobId: typeof value.jobId === 'string' ? value.jobId : null,
      inputFileId: typeof value.inputFileId === 'string' ? value.inputFileId : null,
      idempotencyKey: typeof value.idempotencyKey === 'string' ? value.idempotencyKey : createIdempotencyKey(),
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
      status: typeof value.status === 'string' ? value.status : 'created',
    }
  } catch (error) {
    console.warn('读取旧版 AI 会话失败', error)
    return null
  }
}

function removeLegacySession(): void {
  try {
    wx.removeStorageSync(LEGACY_SESSION_STORAGE_KEY)
  } catch (error) {
    console.warn('清理旧版 AI 会话失败', error)
  }
}

function readMigrationFlag(): boolean {
  try {
    return wx.getStorageSync<boolean>(AI_TASK_MIGRATED_KEY) === true
  } catch {
    return false
  }
}

function markMigrated(): void {
  try {
    wx.setStorageSync(AI_TASK_MIGRATED_KEY, true)
  } catch (error) {
    console.warn('写入 AI 任务迁移标记失败', error)
  }
}

function isAiTask(value: unknown): value is AiTask {
  if (!isRecord(value)) return false
  return (
    nonEmptyString(value.taskId)
    && isTaskStatus(value.status)
    && isNullableNonEmptyString(value.jobId)
    && isNullableNonEmptyString(value.inputFileId)
    && nonEmptyString(value.idempotencyKey)
    && (value.securityCheckId === undefined || nonEmptyString(value.securityCheckId))
    && (value.inputImagePath === undefined || nonEmptyString(value.inputImagePath))
    && nonEmptyString(value.sourceImagePath)
    && typeof value.outputImagePath === 'string'
    && isPatternSettings(value.settings)
    && isStyle(value.style)
    && isDetailLevel(value.detailLevel)
    && isBackgroundMode(value.backgroundMode)
    && (value.failure === null || isFailure(value.failure))
    && isNonNegativeInteger(value.retryCount)
    && isNonNegativeInteger(value.createdAt)
    && isNonNegativeInteger(value.updatedAt)
    && (value.startedAt === null || isNonNegativeInteger(value.startedAt))
    && (value.finishedAt === null || isNonNegativeInteger(value.finishedAt))
  )
}

function isFailure(value: unknown): value is AiGenerationFailure {
  if (!isRecord(value)) return false
  return (
    nonEmptyString(value.code)
    && typeof value.message === 'string'
    && typeof value.retryable === 'boolean'
    && nonEmptyString(value.category)
    && nonEmptyString(value.action)
  )
}

function isTaskStatus(value: unknown): value is AiTaskStatus {
  return value === 'created'
    || value === 'uploading'
    || value === 'submitting'
    || value === 'queued'
    || value === 'processing'
    || value === 'downloading'
    || value === 'converting'
    || value === 'succeeded'
    || value === 'failed'
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

function isStyle(value: unknown): value is AiGenerationStyle {
  return value === 'kawaii' || value === 'natural' || value === 'cartoon' || value === 'minimal'
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
