/**
 * 中位切分（median cut）颜色量化：把图片像素压缩成有限个代表色。
 *
 * 职责：实现经典 median cut 算法——按最宽通道递归二分颜色桶，桶内取均值作为代表色；
 *       不负责把代表色映射到拼豆色号（那是 palette-selector 的事）。
 * 调用方：standard-generator（生成主流程取候选色）。
 * 关键点：每桶权重 = 桶内像素数，后续选色按权重加权；空图返回白色兜底。
 */
import type { RGB } from './color-utils'

/** 带权重的颜色候选：rgb 为代表色，weight 为该色在原图出现的像素数。 */
export interface WeightedColorCandidate {
  rgb: RGB
  weight: number
}

/**
 * 量化出 colorLimit 个代表色（只取 RGB，丢弃权重）。
 * @param pixels 不透明像素数组
 * @param colorLimit 目标颜色数
 */
export function createMedianCutPalette(pixels: RGB[], colorLimit: number): RGB[] {
  return createMedianCutCandidates(pixels, colorLimit).map(
    (candidate) => candidate.rgb,
  )
}

/**
 * 量化出带权重的候选色（代表色 + 像素权重），供后续贪心选色用。
 * @param pixels 不透明像素数组
 * @param candidateLimit 候选色数量上限
 * @returns 每个代表色及其在原图的像素权重
 */
export function createMedianCutCandidates(
  pixels: RGB[],
  candidateLimit: number,
): WeightedColorCandidate[] {
  // 空图兜底：返回白色单一候选，避免后续选色逻辑收到空数组
  if (pixels.length === 0) {
    return [{ rgb: { r: 255, g: 255, b: 255 }, weight: 1 }]
  }
  // 候选数必须是 ≥1 的有限整数。这里不静默兜底成 1：
  // 调用方传 NaN/0 时 `buckets.length < candidateLimit` 恒为 false，循环一次不跑，
  // 函数会「正常返回」一个只有一个候选的结果 —— 调色板直接塌成单色，
  // 而整条链路上没有任何报错，排查时只看得到「颜色不对」。
  if (!Number.isInteger(candidateLimit) || candidateLimit < 1) {
    throw new Error(`createMedianCutCandidates：候选数必须为正整数，收到 ${candidateLimit}`)
  }

  // 刻意复制一份再入桶：下面按通道 sort 是**原地排序**，直接用调用方的 pixels
  // 会把人家的数组顺序改掉。调用方若还要按原顺序遍历像素（采样结果通常就是行优先），
  // 拿到的是一份被重排过的数据，且这种污染不会报错、只会让结果悄悄不对。
  const buckets: RGB[][] = [[...pixels]]
  // 反复把一个桶二分为两个，直到达到候选数或无法再分
  while (buckets.length < candidateLimit) {
    const splitIndex = findBucketToSplit(buckets)
    const bucket = buckets[splitIndex]
    if (bucket.length < 2) break

    // 沿最宽通道排序后在正中切分，得到颜色分布最均衡的两半
    const channel = getWidestChannel(bucket)
    bucket.sort((a, b) => a[channel] - b[channel])
    const middle = Math.floor(bucket.length / 2)
    buckets.splice(splitIndex, 1, bucket.slice(0, middle), bucket.slice(middle))
  }

  return buckets.map((bucket) => ({
    rgb: averageColor(bucket),
    weight: bucket.length,
  }))
}

// 优先切分「颜色跨度×像素数」最大的桶，让误差下降最快
function findBucketToSplit(buckets: RGB[][]): number {
  let selectedIndex = 0
  let selectedScore = -1
  buckets.forEach((bucket, index) => {
    const range = getColorRange(bucket)
    const score = Math.max(range.r, range.g, range.b) * bucket.length
    if (score > selectedScore) {
      selectedScore = score
      selectedIndex = index
    }
  })
  return selectedIndex
}

// 取桶内 r/g/b 跨度最大的通道作为本次切分轴
function getWidestChannel(bucket: RGB[]): keyof RGB {
  const range = getColorRange(bucket)
  if (range.r >= range.g && range.r >= range.b) return 'r'
  if (range.g >= range.b) return 'g'
  return 'b'
}

// 计算桶内每个通道的最大-最小差值（即颜色范围），用于选切分轴与切分优先级
function getColorRange(bucket: RGB[]): RGB {
  const min = { r: 255, g: 255, b: 255 }
  const max = { r: 0, g: 0, b: 0 }
  bucket.forEach((color) => {
    min.r = Math.min(min.r, color.r)
    min.g = Math.min(min.g, color.g)
    min.b = Math.min(min.b, color.b)
    max.r = Math.max(max.r, color.r)
    max.g = Math.max(max.g, color.g)
    max.b = Math.max(max.b, color.b)
  })
  return { r: max.r - min.r, g: max.g - min.g, b: max.b - min.b }
}

// 桶内所有像素的分量均值作为代表色；Math.round 保证落在合法 0~255 整数
function averageColor(bucket: RGB[]): RGB {
  // 空桶取均值会得到 NaN 三元组（0/0），NaN 一路传到 canvas 的 fillStyle 就是静默不绘制。
  // 按项目约定不用「合法值」掩盖异常：宁可在这里炸，也不要下游拿到一份看起来正常的坏颜色。
  if (bucket.length === 0) {
    throw new Error('averageColor：收到空颜色桶，无法计算代表色')
  }
  const total = bucket.reduce(
    (sum, color) => ({
      r: sum.r + color.r,
      g: sum.g + color.g,
      b: sum.b + color.b,
    }),
    { r: 0, g: 0, b: 0 },
  )
  return {
    r: Math.round(total.r / bucket.length),
    g: Math.round(total.g / bucket.length),
    b: Math.round(total.b / bucket.length),
  }
}
