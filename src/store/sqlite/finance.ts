import { CliError } from "@wirecat/cli-base"
import {
  FINANCE_REVIEWS,
  type FinanceReview,
  INVOICE_DIRECTIONS,
  INVOICE_STATUSES,
  type InvoiceDirection,
  type InvoiceStatus,
  invoiceTitle,
  MONEY_DIRECTIONS,
  type MoneyDirection,
  paymentEntryTitle,
  settledStatus,
} from "../../domain/finance.js"
import { currencyOf, formatDecimal, type Money, minorUnits, moneyLabel, moneyOf, scaleOf } from "../../domain/money.js"
import type { DecidedType } from "../../domain/record-types.js"
import type { Decider } from "../decisions.js"
import { type Actor, type ProposedByFilter, proposedBySql } from "./actors.js"
import { decisionsOver } from "./decide.js"
import {
  type Author,
  authorActor,
  authorOf,
  evidenceOf,
  linkEvidence,
  projectId,
  projectOf,
  subjectOf,
} from "./memories.js"
import { type MoneyLine, type MoneyLineInput, moneyLinesOver } from "./money-lines.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { netPaidSql, refundRulesOver } from "./refunds.js"
import { write } from "./transaction.js"

/** A `person:` or `organization:` on an invoice or a payment, with its name so a list needs no lookup. */
export interface Party {
  ref: string
  name: string | null
  /** The owner's own person row. */
  owner: boolean
}

export interface Reviewed {
  review: FinanceReview
  /** `name` is a bot's handle and `kind` whether it is an agent or a rule; both `null` for a person. */
  author: { type: Actor["type"]; id: string; name: string | null; kind: "agent" | "rule" | null }
  model: string | null
  confirmedBy: { type: Actor["type"]; id: string } | null
  source: string
  /** Why an agent or an import proposed it. */
  reason: string | null
  /** What it was read from: the messages, documents or notes an agent or the owner cited. */
  evidence: string[]
  project: string | null
  projectName: string | null
  createdAt: string
  updatedAt: string
}

export interface Invoice extends Reviewed {
  id: string
  ref: string
  /** One line, as a list or the review inbox prints it. */
  title: string
  direction: InvoiceDirection
  number: string | null
  issuer: Party | null
  counterparty: Party
  currency: string
  total: string
  /** Settled by confirmed payments, net of their confirmed refunds. */
  paid: string
  /** Still owed: `total − paid`. */
  open: string
  issueDate: string | null
  dueDate: string | null
  status: InvoiceStatus
  contract: string | null
  subscription: string | null
}

export type InvoiceLine = MoneyLine

export interface Allocation {
  payment: string
  invoice: string
  amount: string
  currency: string
  createdAt: string
}

export interface InvoiceDetail extends Invoice {
  lines: InvoiceLine[]
  allocations: Allocation[]
}

export interface Payment extends Reviewed {
  id: string
  ref: string
  title: string
  direction: MoneyDirection
  payer: Party | null
  payee: Party | null
  amount: string
  currency: string
  /** `YYYY-MM-DD`. */
  date: string
  reference: string | null
  /** Allocated to invoices, confirmed or not. */
  allocated: string
  unallocated: string
  /** The payment this refunds: the other direction, the same currency, never more than it. */
  refundOf: string | null
  subscription: string | null
}

export interface PaymentDetail extends Payment {
  allocations: Allocation[]
}

export interface Written {
  /** The owner's entry is confirmed at once; a bot's waits as proposed for the owner. */
  by: Author
  project?: string
  /** Where a bot's row came from, such as `agent` or an importer's name; the owner's is always `owner`. */
  source?: string
  /** Why a bot proposes it, kept for the reviewer. */
  reason?: string
  /** References it was read from, linked as `evidence`. */
  evidence?: string[]
}

export type InvoiceLineInput = MoneyLineInput

export interface InvoiceInput extends Written {
  direction: InvoiceDirection
  number?: string
  /** `person:` or `organization:`. */
  issuer?: string
  counterparty: string
  currency: string
  /** `YYYY-MM-DD`. */
  issueDate?: string
  dueDate?: string
  /** Kept as a draft until `issueInvoice`; otherwise issued at once. */
  draft?: boolean
  lines: InvoiceLineInput[]
  /** The total printed on the invoice: refused when it is not the sum of the lines. */
  total?: string
  contract?: string
  /** The subscription whose period it bills. */
  subscription?: string
}

export interface PaymentInput extends Written {
  direction: MoneyDirection
  payer?: string
  payee?: string
  amount: string
  currency: string
  date: string
  reference?: string
  /** Invoices it settles, in the payment's currency; a bot's count only once the owner confirms the payment. */
  allocations?: { invoice: string; amount: string }[]
  /** The payment it refunds: it then goes the other way, and is allocated only to invoices that payment settles. */
  refundOf?: string
  subscription?: string
}

interface ListFilter {
  project?: string
  review?: FinanceReview
  proposedBy?: ProposedByFilter
  /** 1–500, 100 by default; newest written first. */
  limit?: number
}

export interface OpenTotal extends Money {
  invoices: number
}

export interface FinanceStore {
  addInvoice(input: InvoiceInput): Promise<InvoiceDetail>
  invoice(reference: string): Promise<InvoiceDetail>
  invoices(
    filter?: ListFilter & {
      direction?: InvoiceDirection
      status?: InvoiceStatus
      /** Issued or partly paid. */
      open?: boolean
      counterparty?: string
      /** The number printed on it, exactly. */
      number?: string
    },
  ): Promise<Invoice[]>
  /** The owner sends a draft: its status then follows its allocations. */
  issueInvoice(reference: string, by: Author): Promise<InvoiceDetail>
  /** The owner cancels an invoice no confirmed payment is allocated to; proposed allocations to it go. */
  voidInvoice(reference: string, by: Author): Promise<InvoiceDetail>
  addPayment(input: PaymentInput): Promise<PaymentDetail>
  payment(reference: string): Promise<PaymentDetail>
  payments(filter?: ListFilter & { direction?: MoneyDirection; party?: string }): Promise<Payment[]>
  /**
   * Settles part of an invoice with part of a payment, in one currency, never beyond either. The owner allocates any
   * payment; a bot only one it proposed that is still proposed.
   */
  allocate(input: { payment: string; invoice: string; amount: string; by: Author }): Promise<Allocation>
  /**
   * Takes one allocation back, under the same rule as `allocate`: the owner from any payment, confirmed too, to set a
   * wrong split right; a bot only from one it proposed that is still proposed.
   */
  unallocate(input: { payment: string; invoice: string; by: Author }): Promise<PaymentDetail>
  /**
   * The owner confirms a proposed `invoice:` or `payment:`; only the owner decides money. A payment whose allocations
   * would settle more than an invoice's total, given the confirmed payments by then, is refused and stays proposed.
   */
  confirm(reference: string, by: Decider, reason?: string): Promise<InvoiceDetail | PaymentDetail>
  /** The owner turns a proposal down; it stays, `rejected`, and its allocations go. */
  reject(reference: string, by: Decider, reason?: string): Promise<InvoiceDetail | PaymentDetail>
  /** What is still owed on confirmed open invoices, per direction and per currency: nothing is converted. */
  openTotals(filter?: { project?: string }): Promise<{ receivable: OpenTotal[]; payable: OpenTotal[] }>
}

type Row = Record<string, unknown>

/** The types `decide` settles money for; other proposal types get their own route. */
const FINANCE_TYPES = ["invoice", "payment"] as const
type FinanceType = (typeof FINANCE_TYPES)[number]
const isFinanceType = (type: string): type is FinanceType => (FINANCE_TYPES as readonly string[]).includes(type)

const article = (word: string) => (/^[aeiou]/.test(word) ? "an" : "a")
/** One article, for the first prefix only: `an invoice: or payment:`. */
export const prefixesText = (types: readonly string[]) =>
  `${article(types[0] ?? "")} ${types.map((type) => `${type}:`).join(" or ")}`

export const refuse = (
  message: string,
  reason: string,
  code: "validation_error" | "permission_error" = "validation_error",
) => {
  throw new CliError(code, message, { reason })
}

export const oneOf = <T extends string>(value: unknown, allowed: readonly T[], what: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T))
    return refuse(`${what} is one of ${allowed.join(", ")}`, "finance.field")
  return value as T
}

export const text = (value: unknown, what: string, limit: number): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
    return refuse(`${what} takes 1–${limit} characters`, "finance.field")
  return value.trim()
}

export const isoDate = (value: unknown, what: string): string | null => {
  if (value === undefined || value === null) return null
  const date = typeof value === "string" ? value.trim() : ""
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    return refuse(`${what} is a date such as 2026-11-15`, "finance.field")
  return date
}

export const iso = (value: unknown) => new Date(Number(value)).toISOString()

const evidenceList = (value: unknown): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8 || value.some((one) => typeof one !== "string" || !one.trim()))
    return refuse("evidence is a list of at most 8 references", "finance.field")
  return [...new Set(value.map((one: string) => one.trim()))]
}
const MAX_LINES = 500

const reasonOf = (metadata: unknown): string | null => {
  if (metadata == null) return null
  try {
    const { reason } = JSON.parse(String(metadata)) as { reason?: unknown }
    return typeof reason === "string" ? reason : null
  } catch {
    return null
  }
}

/** Money settled by confirmed payments only: a proposed payment promises nothing yet. */
const PAID = netPaidSql("i.id")
const INVOICES =
  `SELECT i.*, ${PAID} AS paid, b.name AS author_name, b.kind AS author_kind FROM invoices i ` +
  "LEFT JOIN bots b ON i.author_type = 'bot' AND b.id = i.author_id"
const PAYMENTS =
  "SELECT p.*, (SELECT coalesce(sum(amount), 0) FROM payment_allocations WHERE payment_id = p.id) AS allocated, " +
  "b.name AS author_name, b.kind AS author_kind FROM payments p LEFT JOIN bots b ON p.author_type = 'bot' AND b.id = p.author_id"

/** What invoices, payments and orders share: their parties, who wrote them, and how the owner decides them. */
export const reviewedRowsOver = (context: StoreContext) => {
  const { database } = context

  const partyOf = (type: unknown, id: unknown): Party | null => {
    if (type == null) return null
    const { subject, subjectName, subjectIsOwner } = subjectOf(database, { subject_type: type, subject_id: id })
    return subject === null ? null : { ref: subject, name: subjectName, owner: subjectIsOwner }
  }
  const partyThing = (reference: string | undefined, what: string) => {
    if (reference === undefined) return undefined
    const thing = requiredThing(database, reference, what)
    if (thing.type !== "person" && thing.type !== "organization")
      return refuse(`${what} is a person: or organization: reference, not ${reference}`, "finance.party")
    return thing
  }
  const reviewedOf = (row: Row, type: DecidedType | "deal"): Reviewed => ({
    review: row.review as FinanceReview,
    author: authorOf(row),
    model: row.model == null ? null : String(row.model),
    confirmedBy:
      row.confirmed_by_type == null
        ? null
        : { type: row.confirmed_by_type as Actor["type"], id: String(row.confirmed_by_id) },
    source: String(row.source),
    reason: reasonOf(row.metadata),
    evidence: evidenceOf(context, { type, id: Number(row.id) }),
    ...projectOf(database, row),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  })

  const written = (input: Written) => {
    const owner = input.by === "owner"
    const { actor, model } = authorActor(context, input.by)
    const source = owner ? "owner" : (text(input.source, "a source", 80) ?? "agent")
    const reason = owner ? null : text(input.reason, "a reason", 2000)
    return {
      owner,
      actor,
      model,
      source,
      review: owner ? "confirmed" : "proposed",
      confirmedType: owner ? actor.type : null,
      confirmedId: owner ? actor.id : null,
      metadata: reason === null ? null : JSON.stringify({ reason }),
      project: input.project === undefined ? null : projectId(database, input.project),
      evidence: evidenceList(input.evidence),
    }
  }

  const keepEvidence = (type: DecidedType | "deal", id: number, by: ReturnType<typeof written>) => {
    if (by.evidence.length) linkEvidence(context, { type, id }, by.evidence, by.owner ? "owner" : "agent")
  }

  const ownerOnly = (by: Author, what: string) => {
    if (by !== "owner") refuse(`only the owner ${what}`, "finance.owner-only", "permission_error")
  }

  /** A typed ref of one kind, as its row id; `undefined` passes through. */
  const linkedId = <T extends string>(reference: string | undefined, type: T, reason: string): number | null => {
    if (reference === undefined) return null
    const thing = requiredThing(database, reference, `the ${type}`)
    if (thing.type !== type) return refuse(`${reference} is not ${prefixesText([type])} reference`, reason)
    return thing.id
  }

  return { partyOf, partyThing, reviewedOf, written, keepEvidence, ownerOnly, linkedId, ...decisionsOver(context) }
}

type FinanceOperations = {
  [K in keyof FinanceStore]: FinanceStore[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never
}

export const financeOperationsOver = (context: StoreContext): FinanceOperations => {
  const { database, now } = context
  const { partyOf, partyThing, reviewedOf, written, keepEvidence, ownerOnly, linkedId, decideRow, mayChangeParts } =
    reviewedRowsOver(context)
  const refunds = refundRulesOver(context)
  const lines = moneyLinesOver(context)
  const refOf = (type: string, id: unknown) => (id == null ? null : `${type}:${id}`)

  const invoiceOf = (row: Row): Invoice => {
    const currency = String(row.currency)
    const scale = scaleOf(currency)
    const [total, paid] = [Number(row.total), Number(row.paid)]
    const counterparty = partyOf(row.counterparty_type, row.counterparty_id) as Party
    const fields = {
      id: Number(row.id),
      number: row.number == null ? null : String(row.number),
      direction: row.direction as InvoiceDirection,
      total,
      currency,
      counterpartyName: counterparty?.name ?? null,
      dueDate: row.due_date == null ? null : String(row.due_date),
      status: row.status as InvoiceStatus,
      review: row.review as FinanceReview,
    }
    return {
      id: String(row.id),
      ref: `invoice:${row.id}`,
      title: invoiceTitle(fields),
      direction: fields.direction,
      number: fields.number,
      issuer: partyOf(row.issuer_type, row.issuer_id),
      counterparty,
      currency,
      total: formatDecimal(total, scale),
      paid: formatDecimal(paid, scale),
      open: formatDecimal(Math.max(total - paid, 0), scale),
      issueDate: row.issue_date == null ? null : String(row.issue_date),
      dueDate: fields.dueDate,
      status: fields.status,
      contract: refOf("contract", row.contract_id),
      subscription: refOf("subscription", row.subscription_id),
      ...reviewedOf(row, "invoice"),
    }
  }

  const paymentOf = (row: Row): Payment => {
    const currency = String(row.currency)
    const scale = scaleOf(currency)
    const [amount, allocated] = [Number(row.amount), Number(row.allocated)]
    const direction = row.direction as MoneyDirection
    const payer = partyOf(row.payer_type, row.payer_id)
    const payee = partyOf(row.payee_type, row.payee_id)
    const date = String(row.payment_date)
    return {
      id: String(row.id),
      ref: `payment:${row.id}`,
      title: paymentEntryTitle({
        direction,
        amount,
        currency,
        partyName: (direction === "in" ? payer : payee)?.name ?? null,
        date,
        review: row.review as FinanceReview,
      }),
      direction,
      payer,
      payee,
      amount: formatDecimal(amount, scale),
      currency,
      date,
      reference: row.reference == null ? null : String(row.reference),
      allocated: formatDecimal(allocated, scale),
      unallocated: formatDecimal(amount - allocated, scale),
      refundOf: refOf("payment", row.refund_of),
      subscription: refOf("subscription", row.subscription_id),
      ...reviewedOf(row, "payment"),
    }
  }

  const allocationsWhere = (column: "payment_id" | "invoice_id", id: number): Allocation[] =>
    database
      .prepare(
        "SELECT a.*, p.currency FROM payment_allocations a JOIN payments p ON p.id = a.payment_id " +
          `WHERE a.${column} = ? ORDER BY a.id`,
      )
      .all(id)
      .map((row) => ({
        payment: `payment:${row.payment_id}`,
        invoice: `invoice:${row.invoice_id}`,
        amount: formatDecimal(Number(row.amount), scaleOf(String(row.currency))),
        currency: String(row.currency),
        createdAt: iso(row.created_at),
      }))

  const rowOf = (reference: string, type: "invoice" | "payment"): Row => {
    const thing = requiredThing(database, reference.includes(":") ? reference : `${type}:${reference}`, `the ${type}`)
    if (thing.type !== type) return refuse(`${reference} is not an ${type}`, "finance.ref")
    return database.prepare(`${type === "invoice" ? INVOICES : PAYMENTS} WHERE ${type[0]}.id = ?`).get(thing.id) as Row
  }

  const invoiceDetail = (reference: string): InvoiceDetail => {
    const row = rowOf(reference, "invoice")
    return {
      ...invoiceOf(row),
      lines: lines.shownLines("invoice_lines", "invoice_id", Number(row.id), String(row.currency)),
      allocations: allocationsWhere("invoice_id", Number(row.id)),
    }
  }

  const paymentDetail = (reference: string): PaymentDetail => {
    const row = rowOf(reference, "payment")
    return { ...paymentOf(row), allocations: allocationsWhere("payment_id", Number(row.id)) }
  }

  const settle = (invoiceId: number) => {
    const row = database
      .prepare(`SELECT i.status, i.total, ${PAID} AS paid FROM invoices i WHERE i.id = ?`)
      .get(invoiceId)
    if (!row) return
    const status = settledStatus(row.status as InvoiceStatus, Number(row.total), Number(row.paid))
    database
      .prepare("UPDATE invoices SET status = ?, updated_at = ? WHERE id = ? AND status <> ?")
      .run(status, now(), invoiceId, status)
  }

  const allocateRow = (payment: Row, reference: string, units: number, actor: Actor) => {
    const invoice = rowOf(reference, "invoice")
    const [paymentRef, invoiceRef] = [`payment:${payment.id}`, `invoice:${invoice.id}`]
    if (invoice.deleted_at != null || invoice.review === "rejected")
      refuse(`${invoiceRef} is ${invoice.review === "rejected" ? "rejected" : "deleted"}`, "finance.allocate")
    if (invoice.status === "draft" || invoice.status === "void")
      refuse(`${invoiceRef} is ${invoice.status}; only an issued invoice is paid`, "finance.allocate")
    const currency = String(payment.currency)
    if (invoice.currency !== currency)
      refuse(
        `${paymentRef} is in ${currency} and ${invoiceRef} in ${String(invoice.currency)}; the store converts nothing`,
        "finance.currency",
      )
    const fromPayment = Number(
      database
        .prepare("SELECT coalesce(sum(amount), 0) AS n FROM payment_allocations WHERE payment_id = ?")
        .get(Number(payment.id))?.n,
    )
    if (fromPayment + units > Number(payment.amount))
      refuse(
        `${paymentRef} is ${moneyLabel(Number(payment.amount), currency)} and ` +
          `${moneyLabel(fromPayment, currency)} of it is already allocated; ${moneyLabel(units, currency)} more is too much`,
        "finance.over-payment",
      )
    if (payment.refund_of != null) refunds.refundShare(payment, Number(invoice.id), units)
    else {
      const toInvoice = Number(
        database
          .prepare(`SELECT ${netPaidSql("?", { including: "?" })} AS n`)
          .get(Number(invoice.id), Number(payment.id))?.n,
      )
      if (toInvoice + units > Number(invoice.total))
        refuse(
          `${invoiceRef} totals ${moneyLabel(Number(invoice.total), currency)} and ` +
            `${moneyLabel(toInvoice, currency)} is already allocated to it; ${moneyLabel(units, currency)} more is too much`,
          "finance.over-invoice",
        )
    }
    const at = now()
    database
      .prepare(
        "INSERT INTO payment_allocations (payment_id, invoice_id, amount, author_type, author_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (payment_id, invoice_id) " +
          "DO UPDATE SET amount = amount + excluded.amount, updated_at = excluded.updated_at",
      )
      .run(Number(payment.id), Number(invoice.id), units, actor.type, actor.id, at, at)
    return Number(invoice.id)
  }

  /** A proposed payment's allocations count once confirmed; by then other confirmed payments may cover the invoice. */
  const coveredElsewhere = (paymentId: number) => {
    const over = database
      .prepare(
        `SELECT a.invoice_id, a.amount, i.total, i.currency, ${netPaidSql("a.invoice_id", { excluding: "a.payment_id" })} ` +
          "AS others FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id " +
          "WHERE a.payment_id = ? AND a.amount + others > i.total LIMIT 1",
      )
      .get(paymentId)
    if (!over) return
    const currency = String(over.currency)
    refuse(
      `invoice:${over.invoice_id} is already covered by other payments: ${moneyLabel(Number(over.others), currency)} ` +
        `of ${moneyLabel(Number(over.total), currency)}; payment:${paymentId} would add ` +
        `${moneyLabel(Number(over.amount), currency)}, so it stays proposed`,
      "finance.over-invoice",
    )
  }

  const decide = (reference: string, by: Decider, reason: string | undefined, confirm: boolean) => {
    const thing = requiredThing(database, reference, "the proposal")
    if (!isFinanceType(thing.type)) return refuse(`${reference} is not ${prefixesText(FINANCE_TYPES)}`, "finance.ref")
    const type = thing.type
    const row = rowOf(reference, type)
    const ref = `${type}:${row.id}`
    const id = Number(row.id)
    const payment = type === "payment"
    decideRow(
      type,
      row,
      { by, reason, confirm },
      {
        before: () => {
          if (payment && confirm && row.refund_of != null) refunds.confirmable(row)
          else if (payment && confirm) coveredElsewhere(id)
          if (payment && !confirm) refunds.keepsRefunded(row)
        },
        after: () => {
          const touched = payment
            ? database
                .prepare("SELECT invoice_id FROM payment_allocations WHERE payment_id = ?")
                .all(id)
                .map((one) => Number(one.invoice_id))
            : [id]
          if (!confirm && payment) database.prepare("DELETE FROM payment_allocations WHERE payment_id = ?").run(id)
          if (!confirm && !payment) dropAllocations(id, "")
          for (const invoice of touched) settle(invoice)
        },
      },
    )
    return payment ? paymentDetail(ref) : invoiceDetail(ref)
  }

  /** Refunds' shares go first: a payment's share stays while a refund of it takes part of it back. */
  const dropAllocations = (invoiceId: number, which: string) => {
    for (const refund of [true, false])
      database
        .prepare(
          "DELETE FROM payment_allocations WHERE invoice_id = ? AND payment_id IN " +
            `(SELECT id FROM payments WHERE refund_of IS ${refund ? "NOT " : ""}NULL${which})`,
        )
        .run(invoiceId)
  }

  const mayAllocate = (row: Row, by: Author) =>
    mayChangeParts(
      row,
      by,
      `only the owner allocates payment:${row.id}; a bot allocates only from a payment it proposed that is still proposed`,
    )

  const limitOf = (limit: number | undefined) => Math.min(Math.max(limit ?? 100, 1), 500)

  return {
    addInvoice: (input) => {
      const direction = oneOf(input.direction, INVOICE_DIRECTIONS, "an invoice's direction")
      const currency = currencyOf(input.currency)
      if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_LINES)
        refuse(`an invoice has 1–${MAX_LINES} lines`, "finance.lines")
      const priced = lines.linesOf(input.lines, currency)
      const total = priced.reduce((sum, line) => sum + line.amount, 0)
      if (!Number.isSafeInteger(total)) refuse("an invoice's total is too large", "finance.total")
      if (total <= 0) refuse("an invoice totals more than 0", "finance.total")
      if (input.total !== undefined) {
        const printed = minorUnits(input.total, currency, "an invoice's total")
        if (printed !== total)
          refuse(
            `the invoice's total ${moneyLabel(printed, currency)} is not the sum of its lines, ${moneyLabel(total, currency)}`,
            "finance.total",
          )
      }
      const number = text(input.number, "an invoice's number", 80)
      const issueDate = isoDate(input.issueDate, "an invoice's issue date")
      const dueDate = isoDate(input.dueDate, "an invoice's due date")
      const id = write(database, () => {
        const issuer = partyThing(input.issuer, "the issuer")
        const counterparty =
          partyThing(input.counterparty, "the counterparty") ??
          refuse("an invoice names its counterparty, a person: or organization:", "finance.party")
        const contract = linkedId(input.contract, "contract", "finance.ref")
        const subscription = linkedId(input.subscription, "subscription", "finance.ref")
        const by = written(input)
        const at = now()
        const made = Number(
          database
            .prepare(
              "INSERT INTO invoices (direction, number, issuer_type, issuer_id, counterparty_type, counterparty_id, project_id, " +
                "currency, total, issue_date, due_date, status, review, author_type, author_id, model, confirmed_by_type, " +
                "confirmed_by_id, source, metadata, created_at, updated_at, contract_id, subscription_id) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(
              direction,
              number,
              issuer?.type ?? null,
              issuer?.id ?? null,
              counterparty.type,
              counterparty.id,
              by.project,
              currency,
              total,
              issueDate,
              dueDate,
              input.draft ? "draft" : "issued",
              by.review,
              by.actor.type,
              by.actor.id,
              by.model,
              by.confirmedType,
              by.confirmedId,
              by.source,
              by.metadata,
              at,
              at,
              contract,
              subscription,
            )?.id,
        )
        const insert = database.prepare(
          "INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price, amount, created_at, " +
            "updated_at, catalog_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        for (const [index, line] of priced.entries())
          insert.run(
            made,
            index + 1,
            line.description,
            line.quantity,
            line.unitPrice,
            line.amount,
            at,
            at,
            line.productId,
          )
        keepEvidence("invoice", made, by)
        return made
      })
      return invoiceDetail(`invoice:${id}`)
    },
    invoice: (reference) => invoiceDetail(reference),
    invoices: (filter = {}) => {
      const project = filter.project === undefined ? null : projectId(database, filter.project)
      const counterparty = partyThing(filter.counterparty, "the counterparty")
      const by = proposedBySql("i.author_type", "i.author_id", filter.proposedBy)
      const status = filter.status === undefined ? null : oneOf(filter.status, INVOICE_STATUSES, "a status")
      const review = filter.review === undefined ? null : oneOf(filter.review, FINANCE_REVIEWS, "a review")
      return database
        .prepare(
          `${INVOICES} WHERE i.deleted_at IS NULL AND (? IS NULL OR i.direction = ?) AND (? IS NULL OR i.status = ?) ` +
            "AND (? IS NULL OR i.review = ?) AND (? IS NULL OR i.project_id = ?) " +
            "AND (? IS NULL OR (i.counterparty_type = ? AND i.counterparty_id = ?)) AND (? IS NULL OR i.number = ?) " +
            `${filter.open ? "AND i.status IN ('issued', 'partly_paid') " : ""}AND ${by.sql} ` +
            "ORDER BY i.created_at DESC, i.id DESC LIMIT ?",
        )
        .all(
          filter.direction ?? null,
          filter.direction ?? null,
          status,
          status,
          review,
          review,
          project,
          project,
          counterparty?.type ?? null,
          counterparty?.type ?? null,
          counterparty?.id ?? null,
          filter.number ?? null,
          filter.number ?? null,
          ...by.params,
          limitOf(filter.limit),
        )
        .map(invoiceOf)
    },
    issueInvoice: (reference, by) => {
      ownerOnly(by, "issues an invoice")
      const row = rowOf(reference, "invoice")
      if (row.status !== "draft") refuse(`invoice:${row.id} is ${String(row.status)}, not a draft`, "finance.status")
      write(database, () => {
        database
          .prepare("UPDATE invoices SET status = 'issued', updated_at = ? WHERE id = ?")
          .run(now(), Number(row.id))
        settle(Number(row.id))
      })
      return invoiceDetail(`invoice:${row.id}`)
    },
    voidInvoice: (reference, by) => {
      ownerOnly(by, "voids an invoice")
      const row = rowOf(reference, "invoice")
      if (row.status === "void") refuse(`invoice:${row.id} is already void`, "finance.status")
      const paid = Number(database.prepare(`SELECT ${netPaidSql("?")} AS n`).get(Number(row.id))?.n)
      if (paid > 0)
        refuse(`payments are allocated to invoice:${row.id}; a paid invoice is not voided`, "finance.status")
      write(database, () => {
        dropAllocations(Number(row.id), " AND review = 'proposed'")
        database.prepare("UPDATE invoices SET status = 'void', updated_at = ? WHERE id = ?").run(now(), Number(row.id))
      })
      return invoiceDetail(`invoice:${row.id}`)
    },
    addPayment: (input) => {
      const direction = oneOf(input.direction, MONEY_DIRECTIONS, "a payment's direction")
      const currency = currencyOf(input.currency)
      const amount = minorUnits(input.amount, currency, "a payment's amount")
      if (amount <= 0) refuse("a payment's amount is more than 0", "money.amount")
      const date = isoDate(input.date, "a payment's date") ?? refuse("a payment has a date", "finance.field")
      const reference = text(input.reference, "a payment's reference", 500)
      const allocations = (input.allocations ?? []).map(({ invoice, amount: share }) => ({
        invoice,
        units: minorUnits(share, currency, `the amount allocated to ${invoice}`),
      }))
      const id = write(database, () => {
        const payer = partyThing(input.payer, "the payer")
        const payee = partyThing(input.payee, "the payee")
        const refundOf = linkedId(input.refundOf, "payment", "finance.refund")
        if (refundOf !== null) refunds.originalFor(refundOf, { direction, currency, amount })
        const subscription = linkedId(input.subscription, "subscription", "finance.ref")
        const by = written(input)
        const at = now()
        const made = database
          .prepare(
            "INSERT INTO payments (direction, payer_type, payer_id, payee_type, payee_id, amount, currency, payment_date, " +
              "reference, project_id, review, author_type, author_id, model, confirmed_by_type, confirmed_by_id, source, " +
              "metadata, created_at, updated_at, refund_of, subscription_id) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
          )
          .get(
            direction,
            payer?.type ?? null,
            payer?.id ?? null,
            payee?.type ?? null,
            payee?.id ?? null,
            amount,
            currency,
            date,
            reference,
            by.project,
            by.review,
            by.actor.type,
            by.actor.id,
            by.model,
            by.confirmedType,
            by.confirmedId,
            by.source,
            by.metadata,
            at,
            at,
            refundOf,
            subscription,
          ) as Row
        keepEvidence("payment", Number(made.id), by)
        const touched = allocations.map(({ invoice, units }) => allocateRow(made, invoice, units, by.actor))
        for (const invoice of touched) settle(invoice)
        return Number(made.id)
      })
      return paymentDetail(`payment:${id}`)
    },
    payment: (reference) => paymentDetail(reference),
    payments: (filter = {}) => {
      const project = filter.project === undefined ? null : projectId(database, filter.project)
      const party = partyThing(filter.party, "the party")
      const by = proposedBySql("p.author_type", "p.author_id", filter.proposedBy)
      const review = filter.review === undefined ? null : oneOf(filter.review, FINANCE_REVIEWS, "a review")
      return database
        .prepare(
          `${PAYMENTS} WHERE p.deleted_at IS NULL AND (? IS NULL OR p.direction = ?) AND (? IS NULL OR p.review = ?) ` +
            "AND (? IS NULL OR p.project_id = ?) AND (? IS NULL OR (p.payer_type = ? AND p.payer_id = ?) " +
            `OR (p.payee_type = ? AND p.payee_id = ?)) AND ${by.sql} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
        )
        .all(
          filter.direction ?? null,
          filter.direction ?? null,
          review,
          review,
          project,
          project,
          party?.type ?? null,
          party?.type ?? null,
          party?.id ?? null,
          party?.type ?? null,
          party?.id ?? null,
          ...by.params,
          limitOf(filter.limit),
        )
        .map(paymentOf)
    },
    allocate: ({ payment, invoice, amount, by }) => {
      const row = rowOf(payment, "payment")
      const ref = `payment:${row.id}`
      mayAllocate(row, by)
      if (row.review === "rejected" || row.deleted_at != null)
        refuse(`${ref} is ${String(row.review)}`, "finance.allocate")
      const currency = String(row.currency)
      const units = minorUnits(amount, currency, "an allocation")
      if (units <= 0) refuse("an allocation is more than 0", "money.amount")
      const invoiceId = write(database, () => {
        const { actor } = authorActor(context, by)
        const made = allocateRow(row, invoice, units, actor)
        settle(made)
        return made
      })
      const found = allocationsWhere("payment_id", Number(row.id)).find((one) => one.invoice === `invoice:${invoiceId}`)
      return found as Allocation
    },
    unallocate: ({ payment, invoice, by }) => {
      const row = rowOf(payment, "payment")
      const ref = `payment:${row.id}`
      mayAllocate(row, by)
      if (row.review === "rejected" || row.deleted_at != null)
        refuse(
          `${ref} is ${row.deleted_at != null ? "deleted" : "rejected"}; only a proposed or confirmed payment's ` +
            "allocations are taken back",
          "finance.unallocate",
        )
      const target = rowOf(invoice, "invoice")
      if (row.refund_of == null) refunds.keepsShare(Number(row.id), Number(target.id))
      write(database, () => {
        const gone = database
          .prepare("DELETE FROM payment_allocations WHERE payment_id = ? AND invoice_id = ?")
          .run(Number(row.id), Number(target.id))
        if (gone.changes === 0)
          throw new CliError("not_found", `${ref} is not allocated to invoice:${target.id}`, {
            reason: "finance.not-allocated",
          })
        settle(Number(target.id))
      })
      return paymentDetail(ref)
    },
    confirm: (reference, by, reason) => decide(reference, by, reason, true),
    reject: (reference, by, reason) => decide(reference, by, reason, false),
    openTotals: (filter = {}) => {
      const project = filter.project === undefined ? null : projectId(database, filter.project)
      const rows = database
        .prepare(
          `SELECT i.direction, i.currency, sum(i.total - ${PAID}) AS open, count(*) AS n FROM invoices i ` +
            "WHERE i.review = 'confirmed' AND i.deleted_at IS NULL AND i.status IN ('issued', 'partly_paid') " +
            "AND (? IS NULL OR i.project_id = ?) GROUP BY i.direction, i.currency ORDER BY i.currency",
        )
        .all(project, project)
      const totals = (direction: InvoiceDirection): OpenTotal[] =>
        rows
          .filter((row) => row.direction === direction)
          .map((row) => ({ ...moneyOf(Number(row.open), String(row.currency)), invoices: Number(row.n) }))
      return { receivable: totals("receivable"), payable: totals("payable") }
    },
  }
}

export const financeStoreOver = (context: StoreContext): FinanceStore => {
  const operations = financeOperationsOver(context)
  return {
    addInvoice: async (input) => operations.addInvoice(input),
    invoice: async (reference) => operations.invoice(reference),
    invoices: async (filter) => operations.invoices(filter),
    issueInvoice: async (reference, by) => operations.issueInvoice(reference, by),
    voidInvoice: async (reference, by) => operations.voidInvoice(reference, by),
    addPayment: async (input) => operations.addPayment(input),
    payment: async (reference) => operations.payment(reference),
    payments: async (filter) => operations.payments(filter),
    allocate: async (input) => operations.allocate(input),
    unallocate: async (input) => operations.unallocate(input),
    confirm: async (reference, by, reason) => operations.confirm(reference, by, reason),
    reject: async (reference, by, reason) => operations.reject(reference, by, reason),
    openTotals: async (filter) => operations.openTotals(filter),
  }
}
