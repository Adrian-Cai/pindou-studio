export type MiniProgramEnvironment = 'develop' | 'trial' | 'release'

const API_BASE_URLS: Record<MiniProgramEnvironment, string> = {
  develop: 'http://127.0.0.1:4000',
  trial: '',
  release: '',
}

export class ApiConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiConfigurationError'
  }
}

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

function getMiniProgramEnvironment(): MiniProgramEnvironment {
  try {
    const environment = wx.getAccountInfoSync().miniProgram.envVersion
    if (environment === 'trial' || environment === 'release') return environment
  } catch {
    // 开发者工具或较旧运行环境无法读取时使用本地开发配置。
  }
  return 'develop'
}
