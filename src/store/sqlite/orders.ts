import { CliError } from "@wirecat/cli-base"
import { FINANCE_REVIEWS, type FinanceReview } from "../../domain/finance.js"
import { currencyOf, formatDecimal, minorUnits, scaleOf } from "../../domain/money.js"
import { ORDER_PURPOSES, ORDER_STATUSES, type OrderPurpose, type OrderStatus, orderTitle } from "../../domain/orders.js"
import { assertMayDecide, type Decider, deciderAuthor } from "../decisions.js"
import { fold } from "../normalize.js"
import { ownerPerson, type ProposedByFilter, proposedBySql, proposerOf } from "./actors.js"
import { isoDate, oneOf, type Party, type Reviewed, refuse, reviewedRowsOver, text, type Written } from "./finance.js"
import { type Author, authorActor, projectId } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

export interface Order extends Reviewed {
  id: string
  ref: string
  /** One line, as a list or the review inbox prints it. */
  title: string
  /** Whom it is for: the owner's own person for his own purchase. */
  customer: Party
  purpose: OrderPurpose
  supplier: Party | null
  /** The shop or supplier as its mail names it. */
  supplierName: string
  number: string | null
  /** Both `null` when the mail gave no amount. */
  currency: string | null
  total: string | null
  status: OrderStatus
  /** `YYYY-MM-DD`. */
  orderDate: string | null
  fulfilledDate: string | null
  invoice: string | null
  payment: string | null
}

export interface OrderInput extends Written {
  /** `person:` or `organization:`; the owner's own person when left out. */
  customer?: string
  purpose: OrderPurpose
  supplier?: string
  supplierName: string
  number?: string
  /** A decimal string in `currency`; give both or neither. */
  total?: string
  currency?: string
  /** `placed` when left out. */
  status?: OrderStatus
  orderDate?: string
  fulfilledDate?: string
  invoice?: string
  payment?: string
}

export interface OrderFilter {
  status?: OrderStatus
  purpose?: OrderPurpose
  customer?: string
  /** The shop's name in any letter case; with `number`, how a later mail finds its order. */
  supplierName?: string
  number?: string
  project?: string
  review?: FinanceReview
  proposedBy?: ProposedByFilter
  /** 1–500, 100 by default; newest written first. */
  limit?: number
}

/**
 * What the owner, his business or a client ordered, from whom, and how far delivery got. The owner's entry is
 * confirmed at once; an agent's waits as proposed for him, and only he decides it.
 */
export interface OrdersStore {
  add(input: OrderInput): Promise<Order>
  get(reference: string): Promise<Order>
  list(filter?: OrderFilter): Promise<Order[]>
  /** The owner moves an order on, such as a later mail saying it shipped; `date` is the delivery day. */
  setStatus(reference: string, input: { status: OrderStatus; date?: string; by: Author }): Promise<Order>
  confirm(reference: string, by: Decider, reason?: string): Promise<Order>
  reject(reference: string, by: Decider, reason?: string): Promise<Order>
}

type Row = Record<string, unknown>

const ORDERS =
  "SELECT o.*, b.name AS author_name, b.kind AS author_kind FROM orders o " +
  "LEFT JOIN bots b ON o.author_type = 'bot' AND b.id = o.author_id"

type OrderOperations = {
  [K in keyof OrdersStore]: OrdersStore[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never
}

export const orderOperationsOver = (context: StoreContext): OrderOperations => {
  const { database, now } = context
  const { partyOf, partyThing, reviewedOf, written, keepEvidence, ownerOnly, keepDecision } = reviewedRowsOver(context)

  const orderOf = (row: Row): Order => {
    const currency = row.currency == null ? null : String(row.currency)
    const total = row.total == null || currency === null ? null : Number(row.total)
    const fields = {
      id: Number(row.id),
      number: row.number == null ? null : String(row.number),
      supplierName: String(row.supplier_name),
      total,
      currency,
      status: row.status as OrderStatus,
      review: row.review as FinanceReview,
    }
    return {
      id: String(row.id),
      ref: `order:${row.id}`,
      title: orderTitle(fields),
      customer: partyOf(row.customer_type, row.customer_id) as Party,
      purpose: row.purpose as OrderPurpose,
      supplier: partyOf(row.supplier_type, row.supplier_id),
      supplierName: fields.supplierName,
      number: fields.number,
      currency,
      total: total === null || currency === null ? null : formatDecimal(total, scaleOf(currency)),
      status: fields.status,
      orderDate: row.order_date == null ? null : String(row.order_date),
      fulfilledDate: row.fulfilled_date == null ? null : String(row.fulfilled_date),
      invoice: row.invoice_id == null ? null : `invoice:${row.invoice_id}`,
      payment: row.payment_id == null ? null : `payment:${row.payment_id}`,
      ...reviewedOf(row, "order"),
    }
  }

  const rowOf = (reference: string): Row => {
    const thing = requiredThing(database, reference.includes(":") ? reference : `order:${reference}`, "the order")
    if (thing.type !== "order") return refuse(`${reference} is not an order`, "order.ref")
    return database.prepare(`${ORDERS} WHERE o.id = ?`).get(thing.id) as Row
  }

  const linked = (reference: string | undefined, type: "invoice" | "payment"): number | null => {
    if (reference === undefined) return null
    const thing = requiredThing(database, reference, `the ${type}`)
    if (thing.type !== type) return refuse(`${reference} is not an ${type}: reference`, "order.ref")
    return thing.id
  }

  const statusOf = (value: unknown) => oneOf(value, ORDER_STATUSES, "an order's status")

  const decide = (reference: string, by: Decider, reason: string | undefined, confirm: boolean): Order => {
    const row = rowOf(reference)
    const ref = `order:${row.id}`
    assertMayDecide(
      { id: ref, proposedBy: proposerOf(database, row.author_type, row.author_id), ownerOnly: true },
      by,
      context.decisions,
    )
    if (row.review !== "proposed") refuse(`${ref} is already ${String(row.review)}`, "proposal.wrong-state")
    write(database, () => {
      if (confirm) {
        const { actor } = authorActor(context, deciderAuthor(by))
        database
          .prepare(
            "UPDATE orders SET review = 'confirmed', confirmed_by_type = ?, confirmed_by_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(actor.type, actor.id, now(), Number(row.id))
      } else
        database
          .prepare("UPDATE orders SET review = 'rejected', updated_at = ? WHERE id = ?")
          .run(now(), Number(row.id))
      keepDecision("orders", Number(row.id), by, reason)
    })
    return orderOf(rowOf(ref))
  }

  return {
    add: (input) => {
      const purpose = oneOf(input.purpose, ORDER_PURPOSES, "an order's purpose")
      const status = input.status === undefined ? "placed" : statusOf(input.status)
      const supplierName =
        text(input.supplierName, "an order's supplier name", 200) ??
        refuse("an order names its shop or supplier", "order.field")
      const number = text(input.number, "an order's number", 80)
      if ((input.total === undefined) !== (input.currency === undefined))
        refuse("an order's amount and currency come together", "order.field")
      const currency = input.currency === undefined ? null : currencyOf(input.currency)
      const total = currency === null ? null : minorUnits(input.total as string, currency, "an order's amount")
      if (total !== null && total < 0) refuse("an order's amount is 0 or more", "money.amount")
      const orderDate = isoDate(input.orderDate, "an order's date")
      const fulfilledDate = isoDate(input.fulfilledDate, "an order's delivery date")
      const id = write(database, () => {
        if (number !== null && ordersOfShop(database, supplierName, number).length)
          refuse(`order ${number} from ${supplierName} is already stored; change its status instead`, "order.duplicate")
        const customer = partyThing(input.customer, "the customer") ?? ownerPerson(database)
        const supplier = partyThing(input.supplier, "the supplier")
        const invoice = linked(input.invoice, "invoice")
        const payment = linked(input.payment, "payment")
        const by = written(input)
        const at = now()
        const made = Number(
          database
            .prepare(
              "INSERT INTO orders (customer_type, customer_id, purpose, supplier_type, supplier_id, supplier_name, number, " +
                "currency, total, status, order_date, fulfilled_date, invoice_id, payment_id, project_id, review, " +
                "author_type, author_id, model, confirmed_by_type, confirmed_by_id, source, metadata, created_at, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(
              customer.type,
              customer.id,
              purpose,
              supplier?.type ?? null,
              supplier?.id ?? null,
              supplierName,
              number,
              currency,
              total,
              status,
              orderDate,
              fulfilledDate,
              invoice,
              payment,
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
            )?.id,
        )
        keepEvidence("order", made, by)
        return made
      })
      return orderOf(rowOf(`order:${id}`))
    },
    get: (reference) => orderOf(rowOf(reference)),
    list: (filter = {}) => {
      const project = filter.project === undefined ? null : projectId(database, filter.project)
      const customer = partyThing(filter.customer, "the customer")
      const by = proposedBySql("o.author_type", "o.author_id", filter.proposedBy)
      const status = filter.status === undefined ? null : statusOf(filter.status)
      const purpose = filter.purpose === undefined ? null : oneOf(filter.purpose, ORDER_PURPOSES, "a purpose")
      const review = filter.review === undefined ? null : oneOf(filter.review, FINANCE_REVIEWS, "a review")
      const number = filter.number === undefined ? null : filter.number.trim()
      const shop = filter.supplierName === undefined ? null : fold(filter.supplierName)
      const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
      const rows = database
        .prepare(
          `${ORDERS} WHERE o.deleted_at IS NULL AND (? IS NULL OR o.status = ?) AND (? IS NULL OR o.purpose = ?) ` +
            "AND (? IS NULL OR o.review = ?) AND (? IS NULL OR o.project_id = ?) AND (? IS NULL OR o.number = ?) " +
            "AND (? IS NULL OR (o.customer_type = ? AND o.customer_id = ?)) " +
            `AND ${by.sql} ORDER BY o.created_at DESC, o.id DESC`,
        )
        .all(
          status,
          status,
          purpose,
          purpose,
          review,
          review,
          project,
          project,
          number,
          number,
          customer?.type ?? null,
          customer?.type ?? null,
          customer?.id ?? null,
          ...by.params,
        )
      return rows
        .filter((row) => shop === null || fold(String(row.supplier_name)) === shop)
        .slice(0, limit)
        .map(orderOf)
    },
    setStatus: (reference, { status, date, by }) => {
      ownerOnly(by, "moves an order on")
      const next = statusOf(status)
      const day = isoDate(date, "an order's delivery date")
      const row = rowOf(reference)
      if (row.review === "rejected" || row.deleted_at != null)
        refuse(`order:${row.id} is ${row.deleted_at != null ? "deleted" : "rejected"}`, "order.status")
      write(database, () => {
        database
          .prepare(
            "UPDATE orders SET status = ?, fulfilled_date = coalesce(?, fulfilled_date), updated_at = ? WHERE id = ?",
          )
          .run(next, next === "delivered" ? day : null, now(), Number(row.id))
      })
      return orderOf(rowOf(`order:${row.id}`))
    },
    confirm: (reference, by, reason) => decide(reference, by, reason, true),
    reject: (reference, by, reason) => decide(reference, by, reason, false),
  }
}

/** Orders of one shop with one number that still count: neither rejected nor deleted, the name in any letter case. */
const ordersOfShop = (database: StoreContext["database"], supplierName: string, number: string) => {
  const name = fold(supplierName)
  return database
    .prepare("SELECT id, supplier_name FROM orders WHERE number = ? AND deleted_at IS NULL AND review <> 'rejected'")
    .all(number.trim())
    .filter((row) => fold(String(row.supplier_name)) === name)
}

/** The one stored order of a shop with a number, as a later mail names it; refuses none and more than one. */
export const orderOfShop = (context: StoreContext, supplierName: string, number: string): string => {
  const rows = ordersOfShop(context.database, supplierName, number)
  if (rows.length === 0)
    throw new CliError("not_found", `no stored order ${number} from ${supplierName}`, { reason: "order.not-found" })
  if (rows.length > 1) return refuse(`more than one order ${number} from ${supplierName}`, "order.ref")
  return `order:${rows[0]?.id}`
}

export const ordersStoreOver = (context: StoreContext): OrdersStore => {
  const operations = orderOperationsOver(context)
  return {
    add: async (input) => operations.add(input),
    get: async (reference) => operations.get(reference),
    list: async (filter) => operations.list(filter),
    setStatus: async (reference, input) => operations.setStatus(reference, input),
    confirm: async (reference, by, reason) => operations.confirm(reference, by, reason),
    reject: async (reference, by, reason) => operations.reject(reference, by, reason),
  }
}
