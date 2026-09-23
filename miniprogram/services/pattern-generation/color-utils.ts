export interface RGB {
  r: number
  g: number
  b: number
}

/**
 * 在一组候选里挑「距离最小」的那个。
 *
 * 抽出来是为了收敛一类共性坑：手写这份循环时，空候选数组会让 `best` 停在初始值、
 * 遍历体一次都不执行，函数**静默返回 `undefined`** —— 类型上是具名返回值，
 * 运行时却是 undefined，下游拿到就直接崩，而且崩的位置离这里很远，极难定位。
 * 所以这里规定死：**候选为空就抛错**，让问题在离根因最近的地方暴露。
 *
 * @param items 候选集合
 * @param distance 每个候选的距离度量，越小越优
 * @returns 距离最小的候选；入参为空时抛错
 */
export function pickNearest<T>(
  items: readonly T[],
  distance: (item: T) => number,
): T {
  let best: T | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const item of items) {
    const current = distance(item)
    if (current < bestDistance) {
      best = item
      bestDistance = current
    }
  }
  if (best === undefined) {
    throw new Error('未能选出最近色：候选调色板为空')
  }
  return best
}

/**
 * RGB 转 `#rrggbb`。
 *
 * 分量先收敛到 0~255 整数再转：越界分量（负数、>255、NaN）会拼出 `-1`、`100`、`NaN`
 * 这种不是两位十六进制的串，得到的 `#xxxxxx` 不是合法颜色 —— canvas 和 WXML 都不会报错，
 * 表现只是「这一格/这一块不显示」，从现象完全看不出是颜色格式坏了。
 */
export function rgbToHex(color: RGB): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => toHexByte(channel))
    .join('')}`
}

/** 把单个通道收敛成 0~255 的十六进制字节串。 */
function toHexByte(channel: number): string {
  // 非有限数没有「接近的颜色」可言，落到 0（黑）至少保证产出的仍是合法颜色
  const safe = Number.isFinite(channel) ? Math.min(255, Math.max(0, Math.round(channel))) : 0
  return safe.toString(16).padStart(2, '0')
}
