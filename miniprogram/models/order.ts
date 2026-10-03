export type OrderStatus = 'pending' | 'paid' | 'failed' | 'closed' | 'refunded'

export interface OrderItem {
  id: string
  packageId: string | null
  packageLabel: string
  quotaAmount: number
  quotaKind: 'ai_generation'
  priceFen: number
  currency: 'CNY'
  status: OrderStatus
  createdAt: string
  /** 支付截止时间。null 表示服务端未下发（旧版本服务端），此时前端不展示倒计时。 */
  expiresAt: string | null
  paidAt: string | null
}

export interface OrderListResponse {
  total: number
  page: number
  pageSize: number
  /** 当前 pending 订单数，与服务端「最多 5 个待支付订单」上限同口径。 */
  pendingCount: number
  /** 服务端当前时间，用于校准客户端时钟偏差；倒计时不能拿本机时间直减。 */
  serverTime: string
  items: OrderItem[]
}
