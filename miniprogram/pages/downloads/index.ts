import type { DownloadFileType, DownloadRecord } from '../../models/pattern'
import { appStore } from '../../store/app-store'

type DownloadTab = 'all' | DownloadFileType
type DownloadView = DownloadRecord & {
  typeLabel: string
  typeClass: string
  dateText: string
  dimensions: string
}

const tabs = [
  { id: 'all', label: '全部' },
  { id: 'preview', label: '成品图' },
  { id: 'chart', label: '施工图' },
  { id: 'materials', label: '材料清单' },
] as const

const typeLabels: Record<DownloadFileType, string> = {
  preview: '成品图',
  chart: '施工图',
  materials: '材料清单',
}

Page({
  data: {
    tabs,
    activeTab: 'all' as DownloadTab,
    query: '',
    allRecords: [] as DownloadView[],
    records: [] as DownloadView[],
    quota: 0,
    monthCount: 0,
    recentText: '暂无',
  },

  onShow() {
    const state = appStore.getSnapshot()
    const allRecords = state.downloadRecords.map((record) => ({
      ...record,
      typeLabel: typeLabels[record.fileType],
      typeClass: `download-type--${record.fileType}`,
      dateText: formatDateTime(record.downloadedAt),
      dimensions: record.width && record.height ? `${record.width}×${record.height}` : '尺寸待同步',
    }))
    this.setData({
      allRecords,
      quota: state.downloadQuota,
      monthCount: allRecords.filter((record) => isThisMonth(record.downloadedAt)).length,
      recentText: allRecords.length ? formatRelative(allRecords[0].downloadedAt) : '暂无',
    }, () => this.applyFilters())
  },

  changeTab(event: WechatMiniprogram.TouchEvent) {
    this.setData({ activeTab: String(event.currentTarget.dataset.tab) as DownloadTab }, () => this.applyFilters())
  },

  changeSearch(event: WechatMiniprogram.Input) {
    this.setData({ query: event.detail.value }, () => this.applyFilters())
  },

  applyFilters() {
    const query = this.data.query.trim().toLowerCase()
    const activeTab = this.data.activeTab
    const records = this.data.allRecords.filter((record) => {
      if (query && !record.title.toLowerCase().includes(query)) return false
      return activeTab === 'all' || record.fileType === activeTab
    })
    this.setData({ records })
  },

  showFilter() {
    wx.showActionSheet({
      itemList: ['按时间从新到旧', '按作品名称'],
      success: ({ tapIndex }) => {
        const allRecords = [...this.data.allRecords]
        allRecords.sort(tapIndex === 0
          ? (a, b) => b.downloadedAt - a.downloadedAt
          : (a, b) => a.title.localeCompare(b.title, 'zh-CN'))
        this.setData({ allRecords }, () => this.applyFilters())
      },
    })
  },

  redownload() {
    wx.showToast({ title: '文件导出服务待接入', icon: 'none' })
  },

  openProjects() {
    wx.switchTab({ url: '/pages/projects/index' })
  },

  openRecharge() {
    wx.navigateTo({ url: '/pages/recharge/index' })
  },
})

function isThisMonth(timestamp: number) {
  const date = new Date(timestamp)
  const now = new Date()
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
}

function formatRelative(timestamp: number) {
  const days = Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1000))
  if (days <= 0) return '今天'
  if (days < 7) return `${days} 天内`
  return '较早'
}

function formatDateTime(timestamp: number) {
  const date = new Date(timestamp)
  const datePart = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const timePart = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${datePart} ${timePart}`
}
