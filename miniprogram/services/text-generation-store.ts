/**
 * 文生图任务编号的本地缓存（Storage 封装）。
 *
 * 记住本机最近一次文生图任务编号，重进创作页时恢复「生成中 / 已生成」的预览。
 */

const TEXT_TASK_KEY = 'pindou-text-generation-task-v1'

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
