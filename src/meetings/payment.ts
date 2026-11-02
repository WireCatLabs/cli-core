import { CliError } from "@wirecat/cli-base"

/** Every fact type the store takes; findings and meeting changes check against the same list. */
export const FACT_TYPES = ["fact", "statement", "question", "decision", "promise", "payment"] as const

export const PAYMENT_DIRECTIONS = ["to_us", "from_us"] as const
export const PAYMENT_STATES = ["expected", "paid", "cancelled"] as const

/** A payment fact's fields, kept in `facts.metadata.payment`. */
export interface Payment {
  /** A decimal as text with two places, "50000.00": money is never a float. */
  amount: string
  /** ISO 4217, "RUB". */
  currency: string
  direction: (typeof PAYMENT_DIRECTIONS)[number]
  /** `person:`, `organization:` or `project:`; `null` when only a name is known. */
  counterparty: string | null
  counterparty_name: string | null
  /** An ISO date. */
  due_at: string | null
  /** A change of state is a new fact that supersedes this one, so the history and its evidence stay. */
  state: (typeof PAYMENT_STATES)[number]
  /** What it is for, short: "support, September". The fact's statement is the full sentence. */
  item: string | null
}

const invalid = (message: string): never => {
  throw new CliError("validation_error", message)
}

const CURRENCIES = new Set(Intl.supportedValuesOf("currency"))
const AMOUNT = /^(\d{1,15})(?:\.(\d{1,2}))?$/
const COUNTERPARTY = /^(person|organization|project):[1-9]\d*$/

const amountOf = (value: unknown): string => {
  const match = AMOUNT.exec(typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "")
  if (!match) return invalid("a payment's amount is a positive number with at most 2 decimals, such as 1200.50")
  const amount = `${BigInt(match[1] ?? "0")}.${(match[2] ?? "").padEnd(2, "0")}`
  if (amount === "0.00") return invalid("a payment's amount is more than 0")
  return amount
}

const dateOf = (value: unknown): string => {
  const date = typeof value === "string" ? value.trim() : ""
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    return invalid("a payment's due date is an ISO date, such as 2026-10-31")
  return date
}

const optionalText = (value: unknown, what: string, limit: number): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
    return invalid(`a payment's ${what} takes 1–${limit} characters`)
  return value.trim()
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], what: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T))
    return invalid(`a payment's ${what} is one of ${allowed.join(", ")}`)
  return value as T
}

const FIELDS = ["amount", "currency", "direction", "counterparty", "counterparty_name", "due_at", "state", "item"]

/** A payment as stored: the amount with two decimals, the currency upper case; refuses what is not one. */
export const validatePayment = (input: unknown): Payment => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("a payment is an object")
  const raw = input as Record<string, unknown>
  const unknown = Object.keys(raw).filter((key) => !FIELDS.includes(key))
  if (unknown.length)
    return invalid(`a payment has no field ${unknown.join(", ")}; its fields are ${FIELDS.join(", ")}`)
  const currency = typeof raw.currency === "string" ? raw.currency.trim().toUpperCase() : ""
  if (!/^[A-Z]{3}$/.test(currency) || !CURRENCIES.has(currency))
    return invalid("a payment's currency is an ISO 4217 code, such as EUR or RUB")
  const counterparty = optionalText(raw.counterparty, "counterparty", 80)
  if (counterparty !== null && !COUNTERPARTY.test(counterparty))
    return invalid("a payment's counterparty is a person:, organization: or project: reference")
  return {
    amount: amountOf(raw.amount),
    currency,
    direction: oneOf(raw.direction, PAYMENT_DIRECTIONS, "direction"),
    counterparty,
    counterparty_name: optionalText(raw.counterparty_name, "counterparty name", 200),
    due_at: raw.due_at === undefined || raw.due_at === null ? null : dateOf(raw.due_at),
    state: oneOf(raw.state, PAYMENT_STATES, "state"),
    item: optionalText(raw.item, "item", 200),
  }
}

const grouped = (amount: string): string => {
  const [whole = "0", cents = "00"] = amount.split(".")
  const digits = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  return cents === "00" ? digits : `${digits}.${cents}`
}

/** One line for a payment, as a list or an inbox shows it: "1 200 EUR to us from Ana, due 31.10 (expected)". */
export const paymentTitle = (fact: { payment: Payment | null }): string => {
  const payment = fact.payment
  if (!payment) return ""
  const who = payment.counterparty_name ?? payment.counterparty
  const way = payment.direction === "to_us" ? "to us" : "from us"
  const party = who === null ? "" : payment.direction === "to_us" ? ` from ${who}` : ` to ${who}`
  const due = payment.due_at === null ? "" : `, due ${payment.due_at.slice(8, 10)}.${payment.due_at.slice(5, 7)}`
  const item = payment.item === null ? "" : ` for ${payment.item}`
  return `${grouped(payment.amount)} ${payment.currency} ${way}${party}${item}${due} (${payment.state})`
}
