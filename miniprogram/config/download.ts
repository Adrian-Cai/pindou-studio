import type { DownloadFileType } from '../models/pattern'

export type DownloadSheetState = 'closed' | 'confirm' | 'processing' | 'success'

export interface DownloadTabConfig {
  fileType: DownloadFileType
  title: string
  fileLabel: string
  description: string
  saveLocation: string
  iconType: 'image' | 'document' | 'chart' | 'palette'
  successTitle: string
  successDescription: string
  successHint: string
  primaryActionLabel: string
}

export const DOWNLOAD_CONFIGS: Record<DownloadFileType, DownloadTabConfig> = {
  preview: {
    fileType: 'preview',
    title: '下载成品图',
    fileLabel: 'PNG 高清图',
    description: '适合保存、预览和分享',
    saveLocation: '系统相册',
    iconType: 'image',
    successTitle: '下载成功',
    successDescription: '成品图已保存到系统相册',
    successHint: '可在相册「最近项目」中查看',
    primaryActionLabel: '查看图片',
  },
  materials: {
    fileType: 'materials',
    title: '下载材料清单',
    fileLabel: 'PNG 材料清单',
    description: '适合备料核对与清单保存',
    saveLocation: '系统相册',
    iconType: 'document',
    successTitle: '下载成功',
    successDescription: '材料清单已保存到系统相册',
    successHint: '可在相册「最近项目」中查看',
    primaryActionLabel: '查看图片',
  },
  chart: {
    fileType: 'chart',
    title: '下载施工图',
    fileLabel: 'PNG 编号施工图',
    description: '包含网格编号，适合对照拼装',
    saveLocation: '系统相册',
    iconType: 'chart',
    successTitle: '下载成功',
    successDescription: '施工图已保存到系统相册',
    successHint: '可在相册「最近项目」中查看',
    primaryActionLabel: '查看施工图',
  },
  palette: {
    fileType: 'palette',
    title: '下载色板参考',
    fileLabel: 'PNG 色板参考',
    description: '包含用色明细与数量参考',
    saveLocation: '系统相册',
    iconType: 'palette',
    successTitle: '下载成功',
    successDescription: '色板参考已保存到系统相册',
    successHint: '可在相册「最近项目」中查看',
    primaryActionLabel: '查看色板',
  },
}
