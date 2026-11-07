import { CliError } from "@wirecat/cli-base"
import { dayMonth, type FinanceReview, type MoneyDirection, notes } from "./finance.js"
import { moneyLabel } from "./money.js"

export const CATALOG_KINDS = ["product", "service"] as const
export const CONTRACT_KINDS = ["sale", "purchase", "service", "lease", "employment", "nda", "license", "other"] as const
export const CONTRACT_STATUSES = ["draft", "active", "ended", "terminated"] as const
export const PERIOD_UNITS = ["day", "week", "month", "year"] as const
export const SUBSCRIPTION_STATUSES = ["trial", "active", "paused", "cancelled", "ended"] as const
export const WALLET_KINDS = ["bank", "card", "cash", "wallet", "other"] as const
/** Only a booked transaction counts in a balance; a pending one is shown beside it. */
export const TRANSACTION_STATUSES = ["pending", "booked"] as const
/** `purchase`: the owner buys, as every order before store version 57; `sale`: the owner sells. */
export const ORDER_DIRECTIONS = ["purchase", "sale"] as const

export type CatalogKind = (typeof CATALOG_KINDS)[number]
export type ContractKind = (typeof CONTRACT_KINDS)[number]
export type ContractStatus = (typeof CONTRACT_STATUSES)[number]
export type PeriodUnit = (typeof PERIOD_UNITS)[number]
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]
export type WalletKind = (typeof WALLET_KINDS)[number]
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number]
export type OrderDirection = (typeof ORDER_DIRECTIONS)[number]

export interface Interval {
  count: number
  unit: PeriodUnit
}

/** `1-month`, `2-week` or a bare `year`, as `--every` takes it. */
export const intervalOf = (text: unknown, reason = "subscription.interval"): Interval => {
  const match = typeof text === "string" ? /^(?:([1-9]\d{0,2})-)?(day|week|month|year)$/.exec(text.trim()) : null
  if (!match)
    throw new CliError("validation_error", "an interval is a count and a unit, such as 1-month or 2-week", { reason })
  return { count: match[1] === undefined ? 1 : Number(match[1]), unit: match[2] as PeriodUnit }
}

export const intervalText = ({ count, unit }: Interval): string => `${count}-${unit}`

const priced = (units: number | null, currency: string | null) =>
  units === null || currency === null ? "" : `, ${moneyLabel(units, currency)}`
const pending = (review: FinanceReview) => (review === "confirmed" ? null : review)

export interface ProductTitleFields {
  name: string
  kind: CatalogKind
  unitPrice: number | null
  currency: string | null
  unit: string | null
  archived: boolean
}

/** "Bike rental, month · 10 000.00 RUB per month (service)". */
export const productLine = (product: ProductTitleFields): string => {
  const price =
    product.unitPrice === null || product.currency === null ? "" : moneyLabel(product.unitPrice, product.currency)
  const per = price && product.unit !== null ? ` per ${product.unit}` : ""
  return `${product.name}${price ? ` · ${price}${per}` : ""}${notes(product.kind, product.archived ? "archived" : null)}`
}

export interface ContractTitleFields {
  id: number
  name: string
  number: string | null
  value: number | null
  currency: string | null
  status: ContractStatus
  review: FinanceReview
}

/** "K-2026-14 · Rental agreement, 120 000.00 RUB (active)". */
export const contractLine = (contract: ContractTitleFields): string =>
  `${contract.number ?? `#${contract.id}`} · ${contract.name}${priced(contract.value, contract.currency)}` +
  notes(contract.status, pending(contract.review))

export interface SubscriptionTitleFields {
  name: string
  interval: Interval
  /** The current price, when one is confirmed. */
  price: number | null
  currency: string | null
  status: SubscriptionStatus
  review: FinanceReview
}

/** "Hosting, 990.00 RUB every 1-month (active, proposed)". */
export const subscriptionLine = (subscription: SubscriptionTitleFields): string =>
  `${subscription.name}${priced(subscription.price, subscription.currency)} every ${intervalText(subscription.interval)}` +
  notes(subscription.status, pending(subscription.review))

export interface WalletTitleFields {
  name: string
  kind: WalletKind
  currency: string
  numberHint: string | null
  closed: boolean
}

/** "Tinkoff · bank, RUB, …1234 (closed)". */
export const walletLine = (wallet: WalletTitleFields): string =>
  `${wallet.name} · ${wallet.kind}, ${wallet.currency}${wallet.numberHint === null ? "" : `, …${wallet.numberHint}`}` +
  notes(wallet.closed ? "closed" : null)

export interface TransactionTitleFields {
  direction: MoneyDirection
  amount: number
  currency: string
  /** As the statement names the other side, or else its description. */
  label: string | null
  date: string
  status: TransactionStatus
  review: FinanceReview
}

/** "500.00 RUB out · Кофейня, 14.11 (pending, proposed)". */
export const transactionLine = (transaction: TransactionTitleFields): string =>
  `${moneyLabel(transaction.amount, transaction.currency)} ${transaction.direction}` +
  `${transaction.label === null ? "" : ` · ${transaction.label}`}, ${dayMonth(transaction.date)}` +
  notes(transaction.status === "pending" ? "pending" : null, pending(transaction.review))
