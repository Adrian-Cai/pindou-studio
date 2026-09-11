export type MiniProgramEnvironment = 'develop' | 'trial' | 'release'

const API_BASE_URLS: Record<MiniProgramEnvironment, string> = {
  develop: 'https://api.pindou.wiac.xyz',
  trial: 'https://api.pindou.wiac.xyz',
  release: 'https://api.pindou.wiac.xyz',
}

export class ApiConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiConfigurationError'
  }
}

/** AI 输出只能从项目自己的持久化媒体路径读取，不能直接使用 Provider 临时地址。 */
export const AI_FILE_PUBLIC_BASE_URL = '/api/media/ai'
const AI_FILE_NAME_PATTERN = /^(?:ai_input|ai_output)_[A-Za-z0-9]{32}\.(?:jpg|png|webp)$/u

export function getApiBaseUrl(): string {
  const environment = getMiniProgramEnvironment()
  const baseUrl = API_BASE_URLS[environment].trim().replace(/\/$/, '')
  if (!baseUrl) {
    throw new ApiConfigurationError(
      `${environment} 环境的 HTTPS API 地址尚未配置，请更新 miniprogram/config/api.ts`,
    )
  }
  return baseUrl
}

export function buildApiUrl(path: string): string {
  if (!path.startsWith('/')) throw new ApiConfigurationError('API path 必须以 / 开头')
  return `${getApiBaseUrl()}${path}`
}

export function buildAiFileUrl(value: string): string {
  const url = value.trim()
  if (!url) throw new ApiConfigurationError('AI 输出地址不能为空')

  const relativePrefix = `${AI_FILE_PUBLIC_BASE_URL}/`
  if (url.startsWith('/')) {
    if (!url.startsWith(relativePrefix) || !AI_FILE_NAME_PATTERN.test(url.slice(relativePrefix.length))) {
      throw new ApiConfigurationError('AI 输出地址不是项目媒体地址')
    }
    return buildApiUrl(url)
  }

  const publicBaseUrl = `${getApiBaseUrl()}${AI_FILE_PUBLIC_BASE_URL}`
  if (!url.startsWith(`${publicBaseUrl}/`) || !AI_FILE_NAME_PATTERN.test(url.slice(`${publicBaseUrl}/`.length))) {
    throw new ApiConfigurationError('AI 输出地址不是项目媒体地址')
  }
  return url
}

const LOCAL_COVER_URL_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(\/api\/media\/covers\/[^?#]+)$/u
const RELATIVE_COVER_URL_PATTERN = /^\/api\/media\/covers\/[^?#]+$/u

/**
 * 将历史本地封面地址收敛到当前小程序可访问的 HTTPS API 地址。
 * 合法 CDN 地址保持不变，避免把外部对象存储地址错误改写。
 */
export function normalizeCoverUrl(value: string | null | undefined): string {
  const url = value?.trim() ?? ''
  if (!url) return ''
  if (RELATIVE_COVER_URL_PATTERN.test(url)) return buildApiUrl(url)
  const localMatch = url.match(LOCAL_COVER_URL_PATTERN)
  return localMatch?.[1] ? buildApiUrl(localMatch[1]) : url
}

function getMiniProgramEnvironment(): MiniProgramEnvironment {
  try {
    const environment = wx.getAccountInfoSync().miniProgram.envVersion
    if (environment === 'trial' || environment === 'release') return environment
  } catch {
    // 开发者工具或较旧运行环境无法读取时使用本地开发配置
  }
  return 'develop'
}
