/**
 * 图纸数据模型：定义图片转图纸链路共享的核心类型与少量校验/派生工具。
 *
 * 职责：统一 GenerationMode、PatternSettings、PatternCell、PatternDraft（编辑态）、
 *       PersistedPattern（云端持久化态，去重建调色板、每格存下标）、WorkItem（列表项）、下载相关类型；
 *       提供 isGenerationMode / resolveGenerationMode 两个类型守卫，以及网格压缩用的
 *       encodePatternCells / decodePatternCells。不含任何业务逻辑与 IO。
 * 调用方：生成流程、编辑器、结果页、作品列表、各 service 都引用这里的类型；
 *       本地落盘（store/app-store）与云端上传（services/work-service）共用同一套网格编码。
 * 关键点：透明格在 PatternCell 用 color='transparent'、colorCode='' 表示；
 *       在 PersistedPattern / CompactDraft 里透明格存 -1，其余存 palette 下标以压缩体积。
 */

/** 生成模式：standard=标准图片转图纸；ai=AI 生成。 */
export type GenerationMode = 'standard' | 'ai'
export type CreationSource = 'image' | 'text'

/** 图纸尺寸与色数等设置。 */
export interface PatternSettings {
  width: number
  height: number
  colorLimit: number
  brand: string
}

/** 单个网格：color 为 hex 或 'transparent'，colorCode 为拼豆色号（透明时为空）。 */
export interface PatternCell {
  color: string
  colorCode: string
}

/** 统计图纸实际使用的颜色，供编辑器与 AI 生成页共用调色板排序。 */
export function getPaletteColors(cells: readonly PatternCell[]): string[] {
  const counts = new Map<string, number>()
  cells.forEach((cell) => {
    if (cell.color === 'transparent') return
    counts.set(cell.color, (counts.get(cell.color) ?? 0) + 1)
  })
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 16)
    .map(([color]) => color)
}

/** 编辑态完整草稿（内存中用），cells 为每格的颜色信息。 */
export interface PatternDraft {
  id: string
  sourceImagePath: string
  /** AI 临时草稿使用：首页完成的内容安全检查编号。 */
  contentSecurityCheckId?: string
  /** 与内容安全检查对应的已压缩输入图片路径。 */
  contentSecurityImagePath?: string
  creationSource?: CreationSource
  sourcePrompt?: string
  createdAt: number
  generationMode: GenerationMode
  settings: PatternSettings
  cells: PatternCell[]
}

/** 类型守卫：判断未知值是否为合法 GenerationMode。 */
export function isGenerationMode(value: unknown): value is GenerationMode {
  return value === 'standard' || value === 'ai'
}

/**
 * 由草稿反推生成模式：已有合法 generationMode 直接用，否则按 id 前缀 'ai-pending-' 判定为 ai。
 * @param draft 至少含 id，可能带 generationMode
 */
export function resolveGenerationMode(draft: { id: string; generationMode?: unknown }): GenerationMode {
  if (isGenerationMode(draft.generationMode)) return draft.generationMode
  return draft.id.startsWith('ai-pending-') ? 'ai' : 'standard'
}

/** 持久化调色板的一项：色号 + hex。 */
export interface PersistedPaletteItem {
  code: string
  color: string
}

/** 云端持久化图纸：去重调色板 + 每格存调色板下标（透明格=-1），体积更小。 */
export interface PersistedPattern {
  schemaVersion: 1
  generationMode: GenerationMode
  width: number
  height: number
  settings: Pick<PatternSettings, 'colorLimit' | 'brand'>
  palette: PersistedPaletteItem[]
  cells: number[]
}

/** 紧凑网格：调色板去重后每格只留一个下标，透明格 -1。本机落盘与云端共用这一套编码。 */
export interface CompactPatternCells {
  palette: PersistedPaletteItem[]
  cells: number[]
}

/** 落盘用草稿：cells 不再是逐格对象，压成调色板下标数组，JSON 体积约为原来的 1/5。 */
export type CompactDraft = Omit<PatternDraft, 'cells'> & CompactPatternCells

/**
 * 把逐格颜色压成「调色板 + 下标数组」。
 *
 * 本机 storage 只有 10MB 且按小程序整体配额计，逐格对象（{color,colorCode}×N）撑不了几份草稿；
 * 压成下标后单份 3600 格的图纸从 ~160KB 降到 ~15KB。色号缺失时按调色板顺序补 C01、C02…
 * @param cells 编辑态网格
 */
export function encodePatternCells(cells: readonly PatternCell[]): CompactPatternCells {
  const palette: PersistedPaletteItem[] = []
  const paletteIndexes = new Map<string, number>()
  const packed = cells.map((cell) => {
    // 透明格用下标 -1 表示，省去调色板里的透明项
    if (cell.color === 'transparent') return -1
    // 以「色号\u0000颜色」为键去重，相同色只保留一份
    const key = `${cell.colorCode}\u0000${cell.color.toLowerCase()}`
    const existing = paletteIndexes.get(key)
    if (existing !== undefined) return existing
    const index = palette.length
    paletteIndexes.set(key, index)
    palette.push({ code: cell.colorCode || `C${String(index + 1).padStart(2, '0')}`, color: cell.color })
    return index
  })
  return { palette, cells: packed }
}

/**
 * encodePatternCells 的逆运算。
 * @returns 还原后的网格；下标越界/字段缺失等脏数据返回 null，由调用方决定丢弃还是降级
 */
export function decodePatternCells(payload: CompactPatternCells): PatternCell[] | null {
  if (!Array.isArray(payload?.palette) || !Array.isArray(payload?.cells)) return null
  const cells: PatternCell[] = []
  for (const index of payload.cells) {
    if (index === -1) {
      cells.push({ color: 'transparent', colorCode: '' })
      continue
    }
    if (!Number.isInteger(index)) return null
    const paletteItem = payload.palette[index as number]
    if (!paletteItem) return null
    cells.push({ color: paletteItem.color, colorCode: paletteItem.code })
  }
  return cells
}

/**
 * 作品列表统一项（本地/云端通用），含同步状态与收藏信息。
 *
 * status 语义：
 * - draft / completed：已有真实图纸的普通作品
 * - ai_pending：AI 任务进行中的占位记录（尚无图纸，workId === aiTaskId）
 * - ai_failed：AI 任务失败的占位记录（同上，带 failureCode/failureMessage）
 */
export interface WorkItem {
  id: string
  title: string
  coverPath: string
  generationMode: GenerationMode
  creationSource?: CreationSource
  sourcePrompt?: string
  updatedAt: number
  beadCount: number
  colorCount: number
  width?: number
  height?: number
  status?: WorkStatus
  /** 本地副本与云端的真实同步状态。 */
  syncStatus?: 'guest' | 'pending' | 'synced' | 'failed'
  /** pending / failed 作品归属的账号；游客作品不带该字段。 */
  ownerId?: string
  syncError?: string
  /** 云端作品编辑后离线保存，补传时更新原作品。 */
  pendingCloudUpdate?: boolean
  /** @deprecated 使用 syncStatus 判断，保留以兼容旧缓存。 */
  isCloud?: boolean
  createdAt?: number
  /** 云端摘要携带的收藏状态；进入 AppStore 后由 favoriteIds 统一派生。 */
  isFavorite?: boolean
  favoritedAt?: number
  /** 关联的任务 ID，非 AI 作品不带 */
  aiTaskId?: string
  /** 失败原因，卡片上直接展示 */
  failureCode?: string
  failureMessage?: string
}

/** 作品状态：ai_pending / ai_failed 是 AI 任务的占位态，其余为真实图纸态。 */
export type WorkStatus = 'draft' | 'completed' | 'ai_pending' | 'ai_failed'

/** 是否为 AI 任务的占位作品（生成中或生成失败，尚无图纸）。 */
export function isAiTaskWork(work: Pick<WorkItem, 'status'>): boolean {
  return work.status === 'ai_pending' || work.status === 'ai_failed'
}

/** 是否为未完成的作品：AI 占位态与普通草稿都算。 */
export function isWorkDraft(work: Pick<WorkItem, 'status'>): boolean {
  return work.status !== 'completed'
}

/**
 * 归一化作品的云同步归属：判定这条作品该进「待上云队列」还是「只存本机」。
 *
 * 这是「AI 占位作品不上云」这条不变式的**唯一实现处**。占位作品还没有图纸，
 * 一旦进队列就会被 work-sync-service 以「图案数据不完整」判失败，并把自己写回 failed
 * 从而每次同步反复重试。任何会写 syncStatus / ownerId / isCloud 的入口都必须经过本函数，
 * 不要在调用点各自判断 isAiTaskWork —— 散落判断必然会有入口漏掉。
 *
 * @param work 待归位的作品
 * @param activeUserId 当前登录账号；为 null 表示游客态，此时任何作品都只存本机
 */
export function resolveSyncFields(
  work: Pick<WorkItem, 'status' | 'syncStatus'>,
  activeUserId: string | null,
): Pick<WorkItem, 'syncStatus' | 'ownerId' | 'isCloud'> {
  if (isAiTaskWork(work) || !activeUserId) {
    return { syncStatus: 'guest', ownerId: undefined, isCloud: false }
  }
  // 已同步失败的作品保留 failed，避免重试前被误重置成 pending 而丢失失败态
  return {
    syncStatus: work.syncStatus === 'failed' ? 'failed' : 'pending',
    ownerId: activeUserId,
    isCloud: false,
  }
}

/** 下载文件类型：成品图/施工图/材料清单/色板。 */
export type DownloadFileType = 'preview' | 'chart' | 'materials' | 'palette'

/** 一条本地下载记录。 */
export interface DownloadRecord {
  id: string
  workId: string | null
  title: string
  coverPath: string
  downloadedAt: number
  fileType: DownloadFileType
  width?: number
  height?: number
  colorCount: number
}
