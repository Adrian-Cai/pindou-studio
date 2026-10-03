/**
 * 文生图相关的本地缓存（Storage 封装）。
 *
 * 职责：① 缓存 AI 灵感结果——灵感每次都要真实调用文本模型，重复进入创作页不该重复花钱；
 *       ② 记住本机最近一次文生图任务编号，重进创作页时恢复「生成中 / 已生成」的预览。
 * 关键点：读取一律做结构校验与时效判断，脏数据或过期按「没有缓存」处理，
 *       缓存不可用只应导致多请求一次，绝不能让页面报错。
 */

const INSPIRATION_CACHE_KEY = 'pindou-text-inspirations-v1'
const TEXT_TASK_KEY = 'pindou-text-generation-task-v1'

/** 灵感缓存有效期：半天内重复进入页面直接复用，点「换一换」才强制刷新。 */
export const INSPIRATION_CACHE_TTL_MS = 6 * 60 * 60 * 1_000

export interface InspirationItem {
  title: string
  prompt: string
}

export interface CachedInspirations {
  fetchedAt: number
  items: InspirationItem[]
}

/** 读取仍在有效期内的灵感缓存；无缓存/已过期/结构不合法都返回 null。 */
export function readInspirationCache(now = Date.now()): CachedInspirations | null {
  try {
    const value = wx.getStorageSync<unknown>(INSPIRATION_CACHE_KEY)
    if (!isRecord(value)) return null
    const fetchedAt = typeof value.fetchedAt === 'number' ? value.fetchedAt : Number.NaN
    if (!Number.isFinite(fetchedAt) || now - fetchedAt > INSPIRATION_CACHE_TTL_MS || now < fetchedAt) return null
    if (!Array.isArray(value.items) || !value.items.length || !value.items.every(isInspirationItem)) return null
    return { fetchedAt, items: value.items.map((item) => ({ title: item.title, prompt: item.prompt })) }
  } catch (error) {
    console.warn('读取 AI 灵感缓存失败', error)
    return null
  }
}

export function writeInspirationCache(items: readonly InspirationItem[], now = Date.now()): void {
  try {
    wx.setStorageSync(INSPIRATION_CACHE_KEY, { fetchedAt: now, items: items.map((item) => ({ ...item })) })
  } catch (error) {
    console.warn('写入 AI 灵感缓存失败', error)
  }
}

/** 本机最近一次文生图任务编号；没有记录时返回空串。 */
export function readTextTaskId(): string {
  try {
    const value = wx.getStorageSync<unknown>(TEXT_TASK_KEY)
    return typeof value === 'string' && value.trim() ? value.trim() : ''
  } catch (error) {
    console.warn('读取文生图任务编号失败', error)
    return ''
  }
}

export function writeTextTaskId(jobId: string): void {
  if (!jobId.trim()) return
  try {
    wx.setStorageSync(TEXT_TASK_KEY, jobId.trim())
  } catch (error) {
    console.warn('写入文生图任务编号失败', error)
  }
}

export function clearTextTaskId(): void {
  try {
    wx.removeStorageSync(TEXT_TASK_KEY)
  } catch (error) {
    console.warn('清理文生图任务编号失败', error)
  }
}

function isInspirationItem(value: unknown): value is InspirationItem {
  return isRecord(value)
    && typeof value.title === 'string' && value.title.trim().length > 0
    && typeof value.prompt === 'string' && value.prompt.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
