import { CliError } from "@wirecat/cli-base"
import { ORDER_DIRECTIONS, type OrderDirection } from "../../domain/business.js"
import { sourceUrlOf } from "../../domain/external-links.js"
import { FINANCE_REVIEWS, type FinanceReview } from "../../domain/finance.js"
import { currencyOf, formatDecimal, minorUnits, moneyLabel, scaleOf } from "../../domain/money.js"
import { ORDER_PURPOSES, ORDER_STATUSES, type OrderPurpose, type OrderStatus, orderTitle } from "../../domain/orders.js"
import type { Decider } from "../decisions.js"
import { fold } from "../normalize.js"
import { ownerPerson, type ProposedByFilter, proposedBySql } from "./actors.js"
import { type Author, projectId } from "./memories.js"
import { MAX_LINES, type MoneyLine, type MoneyLineInput, moneyLinesOver, type PricedLine } from "./money-lines.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import {
  isoDate,
  limitOf,
  oneOf,
  type Party,
  type Reviewed,
  refuse,
  reviewedRowsOver,
  text,
  type Written,
} from "./reviewed.js"
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
  /** The order's page at the shop, http or https. */
  sourceUrl: string | null
  /** `sale` when the owner sells: he is then its supplier. */
  direction: OrderDirection
  contract: string | null
  deal: string | null
}

export interface OrderDetail extends Order {
  lines: MoneyLine[]
}

export interface OrderInput extends Written {
  /** `person:` or `organization:`; the owner's own person when left out. */
  customer?: string
  purpose: OrderPurpose
  supplier?: string
  /** Required for a purchase; a sale takes the supplier's name, the owner's by default. */
  supplierName?: string
  number?: string
  /** A decimal string in `currency`; give both or neither. With lines it is their sum, refused when it differs. */
  total?: string
  currency?: string
  /** `placed` when left out. */
  status?: OrderStatus
  orderDate?: string
  fulfilledDate?: string
  invoice?: string
  payment?: string
  /** The order's page at the shop: an http or https address. */
  sourceUrl?: string
  /** `purchase` when left out. A sale names its customer, and its supplier is the owner's own person by default. */
  direction?: OrderDirection
  contract?: string
  /** The deal it came from, when no contract sits between. */
  deal?: string
  /** With lines the order has a currency and totals their sum. */
  lines?: MoneyLineInput[]
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
  add(input: OrderInput): Promise<OrderDetail>
  get(reference: string): Promise<OrderDetail>
  list(filter?: OrderFilter): Promise<Order[]>
  /** The owner moves an order on, such as a later mail saying it shipped; `date` is the delivery day. */
  setStatus(reference: string, input: { status: OrderStatus; date?: string; by: Author }): Promise<Order>
  confirm(reference: string, by: Decider, reason?: string): Promise<Order>
  reject(reference: string, by: Decider, reason?: string): Promise<Order>
  /**
   * Everything an add sets, again: the owner on any order, a bot only on one it proposed that is still proposed, as
   * an import does when its source changed the order. Its lines are replaced; who wrote it and its review stay.
   */
  revise(reference: string, input: OrderInput): Promise<OrderDetail>
  /** A line at the end; the owner changes any order's lines, a bot only those of an order it proposed still proposed. */
  addLine(reference: string, input: MoneyLineInput & { by: Author }): Promise<OrderDetail>
  removeLine(reference: string, input: { position: number; by: Author }): Promise<OrderDetail>
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
  const { partyOf, partyThing, reviewedOf, written, keepEvidence, ownerOnly, linkedId, decideRow, mayChangeParts } =
    reviewedRowsOver(context)
  const moneyLines = moneyLinesOver(context)

  const orderOf = (row: Row): Order => {
    const customer = partyOf(row.customer_type, row.customer_id) as Party
    const direction = row.direction as OrderDirection
    const currency = row.currency == null ? null : String(row.currency)
    const total = row.total == null || currency === null ? null : Number(row.total)
    const fields = {
      id: Number(row.id),
      number: row.number == null ? null : String(row.number),
      supplierName: String(row.supplier_name),
      direction,
      customerName: customer?.name ?? null,
      total,
      currency,
      status: row.status as OrderStatus,
      review: row.review as FinanceReview,
    }
    return {
      id: String(row.id),
      ref: `order:${row.id}`,
      title: orderTitle(fields),
      customer,
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
      sourceUrl: row.source_url == null ? null : String(row.source_url),
      direction,
      contract: row.contract_id == null ? null : `contract:${row.contract_id}`,
      deal: row.deal_id == null ? null : `deal:${row.deal_id}`,
      ...reviewedOf(row, "order"),
    }
  }

  const detailOf = (row: Row): OrderDetail => ({
    ...orderOf(row),
    lines: row.currency == null ? [] : moneyLines.shownLines("order", Number(row.id), String(row.currency)),
  })

  const mayChangeLines = (row: Row, by: Author) => {
    mayChangeParts(
      row,
      by,
      `only the owner changes the lines of order:${row.id}; a bot changes only an order it proposed that is still proposed`,
      "order.owner-only",
    )
    if (row.review === "rejected" || row.deleted_at != null)
      refuse(`order:${row.id} is ${row.deleted_at != null ? "deleted" : "rejected"}`, "order.status")
  }

  const rowOf = (reference: string): Row => {
    const thing = requiredThing(database, reference.includes(":") ? reference : `order:${reference}`, "the order")
    if (thing.type !== "order") return refuse(`${reference} is not an order`, "order.ref")
    return database.prepare(`${ORDERS} WHERE o.id = ?`).get(thing.id) as Row
  }

  const linked = (reference: string | undefined, type: "invoice" | "payment" | "contract" | "deal") =>
    linkedId(reference, type, "order.ref")

  const statusOf = (value: unknown) => oneOf(value, ORDER_STATUSES, "an order's status")

  const decide = (reference: string, by: Decider, reason: string | undefined, confirm: boolean): Order => {
    const row = rowOf(reference)
    decideRow("order", row, { by, reason, confirm })
    return orderOf(rowOf(`order:${row.id}`))
  }

  /** Checks an add's input and writes it: a new order, or `held`'s columns and lines replaced. */
  const save = (input: OrderInput, held?: Row): number => {
    {
      const purpose = oneOf(input.purpose, ORDER_PURPOSES, "an order's purpose")
      const direction =
        input.direction === undefined ? "purchase" : oneOf(input.direction, ORDER_DIRECTIONS, "a direction")
      const status = input.status === undefined ? "placed" : statusOf(input.status)
      const named = text(input.supplierName, "an order's supplier name", 200)
      if (named === null && direction === "purchase") refuse("an order names its shop or supplier", "order.field")
      if (direction === "sale" && input.customer === undefined)
        refuse("a sale names its customer, a person: or organization:", "order.field")
      const number = text(input.number, "an order's number", 80)
      const lines = input.lines ?? []
      if (!Array.isArray(lines) || lines.length > MAX_LINES)
        refuse(`an order has at most ${MAX_LINES} lines`, "order.field")
      if (lines.length && input.currency === undefined) refuse("an order with lines names its currency", "order.total")
      if (!lines.length && (input.total === undefined) !== (input.currency === undefined))
        refuse("an order's amount and currency come together", "order.field")
      const currency = input.currency === undefined ? null : currencyOf(input.currency)
      const priced = currency === null ? [] : moneyLines.linesOf("order", lines, currency)
      const sum = priced.reduce((all, line) => all + line.amount, 0)
      const given =
        currency === null || input.total === undefined ? null : minorUnits(input.total, currency, "an order's amount")
      if (priced.length && given !== null && given !== sum)
        refuse(
          `the order's total ${moneyLabel(given, currency as string)} is not the sum of its lines, ` +
            `${moneyLabel(sum, currency as string)}`,
          "order.total",
        )
      const total = priced.length ? sum : given
      if (total !== null && total < 0) refuse("an order's amount is 0 or more", "money.amount")
      const orderDate = isoDate(input.orderDate, "an order's date")
      const fulfilledDate = isoDate(input.fulfilledDate, "an order's delivery date")
      const sourceUrl = input.sourceUrl === undefined ? null : sourceUrlOf(input.sourceUrl, "order.source-url")
      const id = write(database, () => {
        const customer = partyThing(input.customer, "the customer") ?? ownerPerson(database)
        const supplier =
          partyThing(input.supplier, "the supplier") ?? (direction === "sale" ? ownerPerson(database) : undefined)
        const party = partyOf(supplier?.type, supplier?.id)
        const supplierName = named ?? party?.name ?? (party?.owner ? "owner" : null)
        if (supplierName === null) return refuse("an order names its shop or supplier", "order.field")
        if (
          number !== null &&
          ordersOfShop(database, supplierName, number).some((one) => held === undefined || one.id !== held.id)
        )
          refuse(`order ${number} from ${supplierName} is already stored; change its status instead`, "order.duplicate")
        const invoice = linked(input.invoice, "invoice")
        const payment = linked(input.payment, "payment")
        const contract = linked(input.contract, "contract")
        const deal = linked(input.deal, "deal")
        const at = now()
        if (held !== undefined) {
          const id = Number(held.id)
          database.prepare("DELETE FROM order_lines WHERE order_id = ?").run(id)
          database
            .prepare(
              "UPDATE orders SET customer_type = ?, customer_id = ?, purpose = ?, supplier_type = ?, supplier_id = ?, " +
                "supplier_name = ?, number = ?, currency = ?, total = ?, status = ?, order_date = ?, " +
                "fulfilled_date = ?, invoice_id = ?, payment_id = ?, project_id = ?, source_url = ?, direction = ?, " +
                "contract_id = ?, deal_id = ?, updated_at = ? WHERE id = ?",
            )
            .run(
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
              input.project === undefined ? null : projectId(database, input.project),
              sourceUrl,
              direction,
              contract,
              deal,
              at,
              id,
            )
          moneyLines.insertLines("order", id, priced, 1, at)
          return id
        }
        const by = written(input)
        const made = Number(
          database
            .prepare(
              "INSERT INTO orders (customer_type, customer_id, purpose, supplier_type, supplier_id, supplier_name, number, " +
                "currency, total, status, order_date, fulfilled_date, invoice_id, payment_id, project_id, review, " +
                "author_type, author_id, model, confirmed_by_type, confirmed_by_id, source, metadata, created_at, updated_at, " +
                "source_url, direction, contract_id, deal_id) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
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
              sourceUrl,
              direction,
              contract,
              deal,
            )?.id,
        )
        moneyLines.insertLines("order", made, priced, 1, at)
        keepEvidence("order", made, by)
        return made
      })
      return id
    }
  }

  return {
    add: (input) => detailOf(rowOf(`order:${save(input)}`)),
    revise: (reference, input) => {
      const row = rowOf(reference)
      mayChangeLines(row, input.by)
      return detailOf(rowOf(`order:${save(input, row)}`))
    },
    get: (reference) => detailOf(rowOf(reference)),
    list: (filter = {}) => {
      const project = filter.project === undefined ? null : projectId(database, filter.project)
      const customer = partyThing(filter.customer, "the customer")
      const by = proposedBySql("o.author_type", "o.author_id", filter.proposedBy)
      const status = filter.status === undefined ? null : statusOf(filter.status)
      const purpose = filter.purpose === undefined ? null : oneOf(filter.purpose, ORDER_PURPOSES, "a purpose")
      const review = filter.review === undefined ? null : oneOf(filter.review, FINANCE_REVIEWS, "a review")
      const number = filter.number === undefined ? null : filter.number.trim()
      const shop = filter.supplierName === undefined ? null : fold(filter.supplierName)
      const limit = limitOf(filter.limit)
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
    addLine: (reference, { by, ...line }) => {
      const row = rowOf(reference)
      mayChangeLines(row, by)
      if (row.currency == null) refuse(`order:${row.id} has no currency; a line needs one`, "order.total")
      const [priced] = moneyLines.linesOf("order", [line], String(row.currency)) as [PricedLine]
      write(database, () => {
        moneyLines.appendLine("order", Number(row.id), priced, now())
        moneyLines.retotal("order", Number(row.id), now())
      })
      return detailOf(rowOf(`order:${row.id}`))
    },
    removeLine: (reference, { position, by }) => {
      const row = rowOf(reference)
      mayChangeLines(row, by)
      write(database, () => {
        moneyLines.deleteLine("order", Number(row.id), position)
        moneyLines.retotal("order", Number(row.id), now())
      })
      return detailOf(rowOf(`order:${row.id}`))
    },
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
    addLine: async (reference, input) => operations.addLine(reference, input),
    removeLine: async (reference, input) => operations.removeLine(reference, input),
    revise: async (reference, input) => operations.revise(reference, input),
  }
}
