import { apiRequest, ApiError } from './http-client'

export type SharePage = 'home' | 'projects' | 'profile'

export interface ShareLinkInfo {
  readonly appId: string
  readonly path: string
  readonly query: string
  readonly createTime: number
  readonly expireTime: number
  readonly envVersion: string
}

let copyTask: Promise<void> | null = null

/** 为一级页面生成并复制 30 天有效的微信 URL Link。 */
export function copyPageShareLink(page: SharePage): Promise<void> {
  if (copyTask) return copyTask
  copyTask = createAndCopy(page).finally(() => { copyTask = null })
  return copyTask
}

/** 查询微信 URL Link 对应的页面和有效期。 */
export function queryShareLink(urlLink: string): Promise<{ urlLinkInfo: ShareLinkInfo }> {
  return apiRequest<{ urlLinkInfo: ShareLinkInfo }>({
    path: '/api/share-links/query',
    method: 'POST',
    data: { urlLink },
  })
}

async function createAndCopy(page: SharePage): Promise<void> {
  wx.showLoading({ title: '正在生成链接' })
  try {
    const { urlLink } = await apiRequest<{ urlLink: string }>({
      path: '/api/share-links',
      method: 'POST',
      data: { page },
    })
    await new Promise<void>((resolve, reject) => {
      wx.setClipboardData({
        data: urlLink,
        success: () => resolve(),
        fail: () => reject(new Error('复制链接失败')),
      })
    })
    wx.hideLoading()
    wx.showToast({ title: '链接已复制', icon: 'success' })
  } catch (error) {
    wx.hideLoading()
    wx.showToast({
      title: error instanceof ApiError ? error.message : '分享链接生成失败，请稍后重试',
      icon: 'none',
    })
  }
}
