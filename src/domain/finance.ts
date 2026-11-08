import { moneyLabel } from "./money.js"

export const INVOICE_DIRECTIONS = ["receivable", "payable"] as const
export const INVOICE_STATUSES = ["draft", "issued", "partly_paid", "paid", "void"] as const
/** `in` is money to the owner, `out` money from the owner. */
export const MONEY_DIRECTIONS = ["in", "out"] as const
/** The owner's entry is confirmed at once; an agent's or an import's waits as proposed. */
export const FINANCE_REVIEWS = ["proposed", "confirmed", "rejected"] as const

export type InvoiceDirection = (typeof INVOICE_DIRECTIONS)[number]
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]
export type MoneyDirection = (typeof MONEY_DIRECTIONS)[number]
export type FinanceReview = (typeof FINANCE_REVIEWS)[number]

/** An invoice's status from what confirmed payments settle; `draft` and `void` are the owner's and stay. */
export const settledStatus = (current: InvoiceStatus, total: number, paid: number): InvoiceStatus => {
  if (current === "draft" || current === "void") return current
  if (paid <= 0) return "issued"
  return paid < total ? "partly_paid" : "paid"
}

export const dayMonth = (date: string | null) => (date === null ? null : `${date.slice(8, 10)}.${date.slice(5, 7)}`)

export const notes = (...words: (string | null)[]) => {
  const kept = words.filter((word): word is string => word !== null)
  return kept.length === 0 ? "" : ` (${kept.join(", ")})`
}

export interface InvoiceTitleFields {
  id: number
  number: string | null
  direction: InvoiceDirection
  total: number
  currency: string
  counterpartyName: string | null
  dueDate: string | null
  status: InvoiceStatus
  review: FinanceReview
}

/** "42 · 50 000.00 RUB to ООО Ромашка, due 15.11 (partly paid)": a ref summary's title, which `refLabel` prefixes. */
export const invoiceLine = (invoice: InvoiceTitleFields): string => {
  const party =
    invoice.counterpartyName === null
      ? ""
      : `${invoice.direction === "receivable" ? " to" : " from"} ${invoice.counterpartyName}`
  const due = invoice.dueDate === null ? "" : `, due ${dayMonth(invoice.dueDate)}`
  return (
    `${invoice.number ?? `#${invoice.id}`} · ${moneyLabel(invoice.total, invoice.currency)}${party}${due}` +
    notes(invoice.status.replace("_", " "), invoice.review === "confirmed" ? null : invoice.review)
  )
}

export interface PaymentTitleFields {
  direction: MoneyDirection
  amount: number
  currency: string
  /** Who paid the owner, or whom the owner paid. */
  partyName: string | null
  date: string
  review: FinanceReview
}

/** "50 000.00 RUB from ООО Ромашка, 14.11 (proposed)". */
export const paymentLine = (payment: PaymentTitleFields): string => {
  const party = payment.partyName === null ? "" : `${payment.direction === "in" ? " from" : " to"} ${payment.partyName}`
  return (
    `${moneyLabel(payment.amount, payment.currency)}${party}, ${dayMonth(payment.date)}` +
    notes(payment.review === "confirmed" ? null : payment.review)
  )
}

/** "Invoice 42 · 50 000.00 RUB to ООО Ромашка, due 15.11 (partly paid)". */
export const invoiceTitle = (invoice: InvoiceTitleFields): string => `Invoice ${invoiceLine(invoice)}`

/** "Payment · 50 000.00 RUB from ООО Ромашка, 14.11 (proposed)". */
export const paymentEntryTitle = (payment: PaymentTitleFields): string => `Payment · ${paymentLine(payment)}`
