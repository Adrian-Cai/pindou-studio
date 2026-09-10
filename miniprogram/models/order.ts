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
  paidAt: string | null
}

export interface OrderListResponse {
  total: number
  page: number
  pageSize: number
  items: OrderItem[]
}
