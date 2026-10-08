/** 返回本地自然日标记，供按天展示的一次性提示使用。 */
export function getLocalDateStamp(date = new Date()): string {
  const month = date.getMonth() + 1
  const day = date.getDate()
  return `${date.getFullYear()}-${month < 10 ? `0${month}` : month}-${day < 10 ? `0${day}` : day}`
}

/** 仅当本地保存值等于今天时，视为今日已确认。 */
export function isDailyNoticeAcknowledged(value: unknown, date = new Date()): boolean {
  return value === getLocalDateStamp(date)
}
