import type { OrderDirection } from "./business.js"
import type { FinanceReview } from "./finance.js"
import { moneyLabel } from "./money.js"

export const ORDER_STATUSES = ["placed", "shipped", "delivered", "cancelled", "returned"] as const
/** Why it was ordered: for the owner himself, for his business, for a client, or anything else. */
export const ORDER_PURPOSES = ["personal", "business", "client", "other"] as const

export type OrderStatus = (typeof ORDER_STATUSES)[number]
export type OrderPurpose = (typeof ORDER_PURPOSES)[number]

export interface OrderTitleFields {
  id: number
  number: string | null
  supplierName: string
  direction: OrderDirection
  /** A sale's title names its customer; the supplier is then the owner. */
  customerName: string | null
  total: number | null
  currency: string | null
  status: OrderStatus
  review: FinanceReview
}

/**
 * "12345 · Ozon, 2 499.00 RUB (shipped)", or for a sale "O-55 · to ООО Пример, …": a ref summary's title, which
 * `refLabel` prefixes.
 */
export const orderLine = (order: OrderTitleFields): string => {
  const party =
    order.direction === "sale" && order.customerName !== null ? `to ${order.customerName}` : order.supplierName
  const money = order.total === null || order.currency === null ? "" : `, ${moneyLabel(order.total, order.currency)}`
  const notes = [order.status, order.review === "confirmed" ? null : order.review].filter(Boolean).join(", ")
  return `${order.number ?? `#${order.id}`} · ${party}${money} (${notes})`
}

/** "Order 12345 · Ozon, 2 499.00 RUB (shipped)". */
export const orderTitle = (order: OrderTitleFields): string => `Order ${orderLine(order)}`
