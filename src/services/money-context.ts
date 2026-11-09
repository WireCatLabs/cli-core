import { formatDecimal, minorUnits, scaleOf } from "../domain/money.js"
import type { FinancePayment, Invoice, Order } from "../store/index.js"
import { type Section, sectionOf } from "./business-context.js"

/** How a row reached the context: through the project, or as the organization's own invoice or payment. */
export type LinkedBy = "project" | "counterparty"

export interface InvoiceLine {
  ref: string
  title: string
  direction: Invoice["direction"]
  /** As stored: an invoice is paid only by confirmed payments allocated to it. */
  status: Invoice["status"]
  /** Only confirmed rows are totalled; a proposed one is listed and waits for the owner. */
  review: Invoice["review"]
  currency: string
  total: string
  open: string
  dueDate: string | null
  linkedBy: LinkedBy[]
}

export interface PaymentLine {
  ref: string
  title: string
  direction: FinancePayment["direction"]
  review: FinancePayment["review"]
  currency: string
  amount: string
  date: string
  linkedBy: LinkedBy[]
}

export interface OrderLine {
  ref: string
  title: string
  status: Order["status"]
  review: Order["review"]
  currency: string | null
  total: string | null
  /** The organization is the order's customer or its supplier. */
  side: "customer" | "supplier"
}

/** Confirmed rows summed per status (or direction) and currency: nothing is converted. */
export interface FinanceTotal {
  status: string
  currency: string
  rows: number
  total: string
  /** Of invoices: still owed. */
  open?: string
}

export interface MoneySection {
  invoices: Section<InvoiceLine>
  payments: Section<PaymentLine>
  orders?: Section<OrderLine>
  totals: { invoices: FinanceTotal[]; payments: FinanceTotal[] }
  /** Invoices and payments still proposed, of every row read: listed, never totalled. */
  unconfirmed: number
  /** `false` when a read stopped at the store's page: the totals may leave rows out. */
  complete: boolean
}

const invoiceLine = (invoice: Invoice, linkedBy: LinkedBy): InvoiceLine => ({
  ref: invoice.ref,
  title: invoice.title,
  direction: invoice.direction,
  status: invoice.status,
  review: invoice.review,
  currency: invoice.currency,
  total: invoice.total,
  open: invoice.open,
  dueDate: invoice.dueDate,
  linkedBy: [linkedBy],
})

const paymentLine = (payment: FinancePayment, linkedBy: LinkedBy): PaymentLine => ({
  ref: payment.ref,
  title: payment.title,
  direction: payment.direction,
  review: payment.review,
  currency: payment.currency,
  amount: payment.amount,
  date: payment.date,
  linkedBy: [linkedBy],
})

/** Each row once, with every way it was reached. */
const merged = <T extends { ref: string; linkedBy: LinkedBy[] }>(rows: T[]): T[] => {
  const byRef = new Map<string, T>()
  for (const row of rows) {
    const held = byRef.get(row.ref)
    if (!held) byRef.set(row.ref, { ...row, linkedBy: [...row.linkedBy] })
    else for (const way of row.linkedBy) if (!held.linkedBy.includes(way)) held.linkedBy.push(way)
  }
  return [...byRef.values()]
}

const totalled = (
  rows: { status: string; currency: string; amount: string; open?: string; confirmed: boolean }[],
): FinanceTotal[] => {
  const totals = new Map<string, { status: string; currency: string; rows: number; units: number; open?: number }>()
  for (const row of rows) {
    if (!row.confirmed) continue
    const key = `${row.status}|${row.currency}`
    const held = totals.get(key) ?? { status: row.status, currency: row.currency, rows: 0, units: 0 }
    held.rows += 1
    held.units += minorUnits(row.amount, row.currency)
    if (row.open !== undefined) held.open = (held.open ?? 0) + minorUnits(row.open, row.currency)
    totals.set(key, held)
  }
  return [...totals.values()].map(({ units, open, ...total }) => ({
    ...total,
    total: formatDecimal(units, scaleOf(total.currency)),
    ...(open === undefined ? {} : { open: formatDecimal(open, scaleOf(total.currency)) }),
  }))
}

/**
 * Invoices and payments as the finance store holds them, totalled per status and currency. A payment is never
 * inferred from an invoice, nor an invoice's state from a deal's stage: only what the store records.
 */
export const moneyOf = (
  rows: { invoices: [Invoice, LinkedBy][]; payments: [FinancePayment, LinkedBy][]; orders?: OrderLine[] },
  limit: number,
  next: { invoices: string | null; payments: string | null; orders?: string | null },
  complete: boolean,
): MoneySection => {
  const invoices = merged(rows.invoices.map(([invoice, way]) => invoiceLine(invoice, way)))
  const payments = merged(rows.payments.map(([payment, way]) => paymentLine(payment, way)))
  const more = { more: !complete }
  return {
    invoices: sectionOf(invoices, limit, next.invoices, more),
    payments: sectionOf(payments, limit, next.payments, more),
    ...(rows.orders === undefined ? {} : { orders: sectionOf(rows.orders, limit, next.orders ?? null, more) }),
    totals: {
      invoices: totalled(invoices.map((one) => ({ ...one, amount: one.total, confirmed: one.review === "confirmed" }))),
      payments: totalled(
        payments.map((one) => ({ ...one, status: one.direction, confirmed: one.review === "confirmed" })),
      ),
    },
    unconfirmed: [...invoices, ...payments].filter((one) => one.review !== "confirmed").length,
    complete,
  }
}
