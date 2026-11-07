import { CliError } from "@wirecat/cli-base"
import {
  type Interval,
  intervalOf,
  type PeriodUnit,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
  subscriptionLine,
} from "../../domain/business.js"
import { FINANCE_REVIEWS, type FinanceReview, INVOICE_DIRECTIONS, type InvoiceDirection } from "../../domain/finance.js"
import { currencyOf, formatDecimal, type Money, minorUnits, scaleOf } from "../../domain/money.js"
import type { Decider } from "../decisions.js"
import { ownerPerson, type ProposedByFilter, proposedBySql } from "./actors.js"
import {
  iso,
  isoDate,
  oneOf,
  type Party,
  type Reviewed,
  refuse,
  reviewedRowsOver,
  text,
  type Written,
} from "./finance.js"
import { type Author, authorOf, projectId } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

export interface SubscriptionPrice extends Money {
  /** `subscription_price:<id>`: its own proposal, never changed once written. */
  id: string
  subscription: string
  /** `YYYY-MM-DD`: the first day it is billed. */
  effectiveFrom: string
  review: FinanceReview
  author: { type: "person" | "bot"; id: string; name: string | null; kind: "agent" | "rule" | null }
  reason: string | null
  createdAt: string
}

export interface Subscription extends Reviewed {
  id: string
  ref: string
  /** One line, as a list or the review inbox prints it. */
  title: string
  name: string
  /** `receivable` when the owner bills it, `payable` when he pays it. */
  direction: InvoiceDirection
  supplier: Party
  customer: Party
  product: string | null
  contract: string | null
  status: SubscriptionStatus
  interval: Interval
  /** `YYYY-MM-DD`. */
  startDate: string
  trialEndDate: string | null
  nextRenewalDate: string | null
  cancelledDate: string | null
  endDate: string | null
  /** The confirmed price with the latest start up to today; `null` before one is confirmed. */
  currentPrice: SubscriptionPrice | null
}

export interface SubscriptionDetail extends Subscription {
  /** Every price, oldest start first, rejected ones too: history is never overwritten. */
  prices: SubscriptionPrice[]
}

export interface PriceInput {
  /** A decimal string in `currency`. */
  amount: string
  currency: string
  /** `YYYY-MM-DD`; the subscription's start when left out. */
  effectiveFrom?: string
}

export interface SubscriptionInput extends Written {
  /** The product's name when left out. */
  name?: string
  direction: InvoiceDirection
  /** The owner's own person when left out of a receivable one. */
  supplier?: string
  /** The owner's own person when left out of a payable one. */
  customer?: string
  product?: string
  contract?: string
  /** `trial` when a trial end is given, else `active`. */
  status?: SubscriptionStatus
  /** A count and a unit, such as 1-month, as `--every` takes it. */
  every: string
  startDate: string
  trialEndDate?: string
  nextRenewalDate?: string
  cancelledDate?: string
  endDate?: string
  /** Its first price, proposed or confirmed with the subscription. */
  price?: PriceInput
}

export interface SubscriptionUpdate {
  by: Author
  name?: string
  status?: SubscriptionStatus
  nextRenewalDate?: string | null
  /** Today when it is cancelled and no day is given. */
  cancelledDate?: string | null
  endDate?: string | null
}

export interface SubscriptionFilter {
  status?: SubscriptionStatus
  direction?: InvoiceDirection
  supplier?: string
  customer?: string
  project?: string
  review?: FinanceReview
  proposedBy?: ProposedByFilter
  /** `YYYY-MM-DD`: only those that renew on or before it. */
  renewsBy?: string
  /** 1–500, 100 by default; newest written first. */
  limit?: number
}

/**
 * Subscriptions the owner bills or pays, and their prices. A price is a row of its own and never changes: a new price
 * from an agent on a confirmed subscription is a proposal of its own, and the subscription stays confirmed.
 */
export interface SubscriptionsStore {
  add(input: SubscriptionInput): Promise<SubscriptionDetail>
  get(reference: string): Promise<SubscriptionDetail>
  list(filter?: SubscriptionFilter): Promise<Subscription[]>
  update(reference: string, input: SubscriptionUpdate): Promise<SubscriptionDetail>
  addPrice(reference: string, input: PriceInput & Omit<Written, "project" | "evidence">): Promise<SubscriptionPrice>
  /** `subscription:<id>` or `subscription_price:<id>`. */
  confirm(reference: string, by: Decider, reason?: string): Promise<SubscriptionDetail>
  reject(reference: string, by: Decider, reason?: string): Promise<SubscriptionDetail>
  price(id: string): Promise<SubscriptionPrice>
  /** Proposed or decided prices, newest written first, as the review inbox lists them. */
  prices(filter?: {
    review?: FinanceReview
    proposedBy?: ProposedByFilter
    limit?: number
  }): Promise<SubscriptionPrice[]>
}

type Row = Record<string, unknown>

const SUBSCRIPTIONS =
  "SELECT s.*, b.name AS author_name, b.kind AS author_kind FROM subscriptions s " +
  "LEFT JOIN bots b ON s.author_type = 'bot' AND b.id = s.author_id"
const PRICES =
  "SELECT p.*, b.name AS author_name, b.kind AS author_kind FROM subscription_prices p " +
  "LEFT JOIN bots b ON p.author_type = 'bot' AND b.id = p.author_id"
const PRICE_ID = /^subscription_price:([1-9]\d{0,15})$/

const reasonOf = (metadata: unknown): string | null => {
  try {
    const { reason } = JSON.parse(String(metadata ?? "{}")) as { reason?: unknown }
    return typeof reason === "string" ? reason : null
  } catch {
    return null
  }
}

type SubscriptionOperations = {
  [K in keyof SubscriptionsStore]: SubscriptionsStore[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => R
    : never
}

export const subscriptionOperationsOver = (context: StoreContext): SubscriptionOperations => {
  const { database, now } = context
  const { partyOf, partyThing, reviewedOf, written, keepEvidence, linkedId, decideRow, mayChangeParts } =
    reviewedRowsOver(context)
  const today = () => new Date(now()).toISOString().slice(0, 10)

  const priceOf = (row: Row): SubscriptionPrice => {
    const currency = String(row.currency)
    return {
      id: `subscription_price:${row.id}`,
      subscription: `subscription:${row.subscription_id}`,
      amount: formatDecimal(Number(row.amount), scaleOf(currency)),
      currency,
      effectiveFrom: String(row.effective_from),
      review: row.review as FinanceReview,
      author: authorOf(row),
      reason: reasonOf(row.metadata),
      createdAt: iso(row.created_at),
    }
  }

  const pricesOf = (id: number) =>
    database.prepare(`${PRICES} WHERE p.subscription_id = ? ORDER BY p.effective_from, p.id`).all(id).map(priceOf)

  const subscriptionOf = (row: Row): Subscription => {
    const interval = { count: Number(row.interval_count), unit: row.interval_unit as PeriodUnit }
    const current = database
      .prepare(
        `${PRICES} WHERE p.subscription_id = ? AND p.review = 'confirmed' AND p.effective_from <= ? ` +
          "ORDER BY p.effective_from DESC LIMIT 1",
      )
      .get(Number(row.id), today())
    const currentPrice = current ? priceOf(current) : null
    const fields = {
      name: String(row.name),
      interval,
      price: current ? Number(current.amount) : null,
      currency: currentPrice?.currency ?? null,
      status: row.status as SubscriptionStatus,
      review: row.review as FinanceReview,
    }
    return {
      id: String(row.id),
      ref: `subscription:${row.id}`,
      title: `Subscription ${subscriptionLine(fields)}`,
      name: fields.name,
      direction: row.direction as InvoiceDirection,
      supplier: partyOf(row.supplier_type, row.supplier_id) as Party,
      customer: partyOf(row.customer_type, row.customer_id) as Party,
      product: row.catalog_item_id == null ? null : `product:${row.catalog_item_id}`,
      contract: row.contract_id == null ? null : `contract:${row.contract_id}`,
      status: fields.status,
      interval,
      startDate: String(row.start_date),
      trialEndDate: row.trial_end_date == null ? null : String(row.trial_end_date),
      nextRenewalDate: row.next_renewal_date == null ? null : String(row.next_renewal_date),
      cancelledDate: row.cancelled_date == null ? null : String(row.cancelled_date),
      endDate: row.end_date == null ? null : String(row.end_date),
      currentPrice,
      ...reviewedOf(row, "subscription"),
    }
  }

  const rowOf = (reference: string): Row => {
    const thing = requiredThing(
      database,
      reference.includes(":") ? reference : `subscription:${reference}`,
      "the subscription",
    )
    if (thing.type !== "subscription") return refuse(`${reference} is not a subscription`, "subscription.ref")
    return database.prepare(`${SUBSCRIPTIONS} WHERE s.id = ?`).get(thing.id) as Row
  }

  const priceRowOf = (id: string): Row => {
    const match = PRICE_ID.exec(id.trim())
    const row = match ? database.prepare(`${PRICES} WHERE p.id = ?`).get(Number(match[1])) : undefined
    if (!row) throw new CliError("not_found", `no subscription price ${id}`, { reason: "subscription.no-price" })
    return row
  }

  const detailOf = (reference: string): SubscriptionDetail => {
    const row = rowOf(reference)
    return { ...subscriptionOf(row), prices: pricesOf(Number(row.id)) }
  }

  const datesValid = (start: string, dates: { trial: unknown; cancelled: unknown; end: unknown }, status: string) => {
    if (dates.trial != null && String(dates.trial) < start)
      refuse("a trial ends on or after the subscription starts", "subscription.field")
    if (dates.end != null && String(dates.end) < start)
      refuse("a subscription ends on or after it starts", "subscription.field")
    if (status === "trial" && dates.trial == null)
      refuse("a subscription in trial has a trial end", "subscription.field")
    if (status === "cancelled" && dates.cancelled == null)
      refuse("a cancelled subscription has the day it was cancelled", "subscription.field")
  }

  const insertPrice = (subscriptionId: number, price: PriceInput, start: string, by: ReturnType<typeof written>) => {
    const currency = currencyOf(price.currency)
    const amount = minorUnits(price.amount, currency, "a subscription's price")
    const from = isoDate(price.effectiveFrom, "the price's first day") ?? start
    if (
      database
        .prepare(
          "SELECT 1 FROM subscription_prices WHERE subscription_id = ? AND effective_from = ? AND review <> 'rejected'",
        )
        .get(subscriptionId, from)
    )
      refuse(
        `subscription:${subscriptionId} already has a price from ${from}; reject it to correct it`,
        "subscription.price",
      )
    const at = now()
    return Number(
      database
        .prepare(
          "INSERT INTO subscription_prices (subscription_id, amount, currency, effective_from, review, author_type, " +
            "author_id, model, confirmed_by_type, confirmed_by_id, source, metadata, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .get(
          subscriptionId,
          amount,
          currency,
          from,
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
  }

  const decide = (reference: string, by: Decider, reason: string | undefined, confirm: boolean) => {
    if (PRICE_ID.test(reference.trim())) {
      const price = priceRowOf(reference)
      const parent = rowOf(`subscription:${price.subscription_id}`)
      if (confirm && parent.review !== "confirmed")
        refuse(
          `subscription:${parent.id} is ${String(parent.review)}; confirm the subscription before its price`,
          "subscription.price",
        )
      decideRow("subscription_price", price, { by, reason, confirm })
      return detailOf(`subscription:${parent.id}`)
    }
    const row = rowOf(reference)
    decideRow(
      "subscription",
      row,
      { by, reason, confirm },
      {
        // A price of a rejected subscription would bill nothing; it goes with it.
        after: () => {
          if (!confirm)
            database
              .prepare(
                "UPDATE subscription_prices SET review = 'rejected', updated_at = ? WHERE subscription_id = ? AND review = 'proposed'",
              )
              .run(now(), Number(row.id))
        },
      },
    )
    return detailOf(`subscription:${row.id}`)
  }

  return {
    add: (input) => {
      const direction = oneOf(input.direction, INVOICE_DIRECTIONS, "a subscription's direction")
      const interval = intervalOf(input.every)
      const start =
        isoDate(input.startDate, "a subscription's start") ??
        refuse("a subscription starts on a day", "subscription.field")
      const dates = {
        trial: isoDate(input.trialEndDate, "a trial's end"),
        renewal: isoDate(input.nextRenewalDate, "the next renewal"),
        cancelled: isoDate(input.cancelledDate, "the day it was cancelled"),
        end: isoDate(input.endDate, "a subscription's end"),
      }
      const status =
        input.status === undefined
          ? dates.trial === null
            ? "active"
            : "trial"
          : oneOf(input.status, SUBSCRIPTION_STATUSES, "a subscription's status")
      datesValid(start, dates, status)
      const id = write(database, () => {
        const owner = ownerPerson(database)
        const supplier = partyThing(input.supplier, "the supplier") ?? (direction === "receivable" ? owner : undefined)
        const customer = partyThing(input.customer, "the customer") ?? (direction === "payable" ? owner : undefined)
        if (!supplier || !customer)
          refuse("a subscription names its supplier and its customer, a person: or organization:", "subscription.field")
        const product = linkedId(input.product, "product", "subscription.ref")
        const contract = linkedId(input.contract, "contract", "subscription.ref")
        const productName =
          product === null
            ? null
            : String(database.prepare("SELECT name FROM catalog_items WHERE id = ?").get(product)?.name)
        const name =
          text(input.name, "a subscription's name", 200) ??
          productName ??
          refuse("a subscription needs a name, or a product to take it from", "subscription.field")
        const by = written(input)
        const at = now()
        const made = Number(
          database
            .prepare(
              "INSERT INTO subscriptions (name, direction, supplier_type, supplier_id, customer_type, customer_id, " +
                "catalog_item_id, contract_id, project_id, status, interval_count, interval_unit, start_date, trial_end_date, " +
                "next_renewal_date, cancelled_date, end_date, review, author_type, author_id, model, confirmed_by_type, " +
                "confirmed_by_id, source, metadata, created_at, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(
              name,
              direction,
              supplier?.type ?? null,
              supplier?.id ?? null,
              customer?.type ?? null,
              customer?.id ?? null,
              product,
              contract,
              by.project,
              status,
              interval.count,
              interval.unit,
              start,
              dates.trial,
              dates.renewal,
              dates.cancelled,
              dates.end,
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
        if (input.price !== undefined) insertPrice(made, input.price, start, by)
        keepEvidence("subscription", made, by)
        return made
      })
      return detailOf(`subscription:${id}`)
    },
    get: (reference) => detailOf(reference),
    list: (filter = {}) => {
      const project = filter.project === undefined ? null : projectId(database, filter.project)
      const supplier = partyThing(filter.supplier, "the supplier")
      const customer = partyThing(filter.customer, "the customer")
      const status = filter.status === undefined ? null : oneOf(filter.status, SUBSCRIPTION_STATUSES, "a status")
      const direction =
        filter.direction === undefined ? null : oneOf(filter.direction, INVOICE_DIRECTIONS, "a direction")
      const review = filter.review === undefined ? null : oneOf(filter.review, FINANCE_REVIEWS, "a review")
      const renews = isoDate(filter.renewsBy, "the last renewal day")
      const by = proposedBySql("s.author_type", "s.author_id", filter.proposedBy)
      return database
        .prepare(
          `${SUBSCRIPTIONS} WHERE s.deleted_at IS NULL AND (? IS NULL OR s.status = ?) AND (? IS NULL OR s.direction = ?) ` +
            "AND (? IS NULL OR s.review = ?) AND (? IS NULL OR s.project_id = ?) " +
            "AND (? IS NULL OR (s.supplier_type = ? AND s.supplier_id = ?)) " +
            "AND (? IS NULL OR (s.customer_type = ? AND s.customer_id = ?)) " +
            `AND (? IS NULL OR s.next_renewal_date <= ?) AND ${by.sql} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
        )
        .all(
          status,
          status,
          direction,
          direction,
          review,
          review,
          project,
          project,
          supplier?.type ?? null,
          supplier?.type ?? null,
          supplier?.id ?? null,
          customer?.type ?? null,
          customer?.type ?? null,
          customer?.id ?? null,
          renews,
          renews,
          ...by.params,
          Math.min(Math.max(filter.limit ?? 100, 1), 500),
        )
        .map(subscriptionOf)
    },
    update: (reference, input) => {
      const row = rowOf(reference)
      const ref = `subscription:${row.id}`
      if (row.review === "rejected" || row.deleted_at != null)
        refuse(`${ref} is ${row.deleted_at != null ? "deleted" : "rejected"}`, "subscription.ref")
      mayChangeParts(
        row,
        input.by,
        `only the owner changes ${ref}; a bot changes only a subscription it proposed that is still proposed`,
      )
      const status =
        input.status === undefined ? String(row.status) : oneOf(input.status, SUBSCRIPTION_STATUSES, "a status")
      const day = (given: string | null | undefined, column: string, what: string) =>
        given === undefined ? (row[column] ?? null) : isoDate(given, what)
      const cancelled =
        input.cancelledDate === undefined && status === "cancelled" && row.cancelled_date == null
          ? today()
          : day(input.cancelledDate, "cancelled_date", "the day it was cancelled")
      const dates = {
        trial: row.trial_end_date,
        renewal: day(input.nextRenewalDate, "next_renewal_date", "the next renewal"),
        cancelled,
        end: day(input.endDate, "end_date", "a subscription's end"),
      }
      datesValid(String(row.start_date), dates, status)
      const name =
        input.name === undefined ? String(row.name) : (text(input.name, "a subscription's name", 200) as string)
      write(database, () => {
        database
          .prepare(
            "UPDATE subscriptions SET name = ?, status = ?, next_renewal_date = ?, cancelled_date = ?, end_date = ?, " +
              "updated_at = ? WHERE id = ?",
          )
          .run(
            name,
            status,
            dates.renewal as string | null,
            dates.cancelled as string | null,
            dates.end as string | null,
            now(),
            Number(row.id),
          )
      })
      return detailOf(ref)
    },
    addPrice: (reference, input) => {
      const row = rowOf(reference)
      if (row.review === "rejected" || row.deleted_at != null)
        refuse(`subscription:${row.id} is ${row.deleted_at != null ? "deleted" : "rejected"}`, "subscription.ref")
      const id = write(database, () => insertPrice(Number(row.id), input, String(row.start_date), written(input)))
      return priceOf(database.prepare(`${PRICES} WHERE p.id = ?`).get(id) as Row)
    },
    confirm: (reference, by, reason) => decide(reference, by, reason, true),
    reject: (reference, by, reason) => decide(reference, by, reason, false),
    price: (id) => priceOf(priceRowOf(id)),
    prices: (filter = {}) => {
      const review = filter.review === undefined ? null : oneOf(filter.review, FINANCE_REVIEWS, "a review")
      const by = proposedBySql("p.author_type", "p.author_id", filter.proposedBy)
      return database
        .prepare(
          `${PRICES} WHERE (? IS NULL OR p.review = ?) AND ${by.sql} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
        )
        .all(review, review, ...by.params, Math.min(Math.max(filter.limit ?? 100, 1), 500))
        .map(priceOf)
    },
  }
}

export const subscriptionsStoreOver = (context: StoreContext): SubscriptionsStore => {
  const operations = subscriptionOperationsOver(context)
  return {
    add: async (input) => operations.add(input),
    get: async (reference) => operations.get(reference),
    list: async (filter) => operations.list(filter),
    update: async (reference, input) => operations.update(reference, input),
    addPrice: async (reference, input) => operations.addPrice(reference, input),
    confirm: async (reference, by, reason) => operations.confirm(reference, by, reason),
    reject: async (reference, by, reason) => operations.reject(reference, by, reason),
    price: async (id) => operations.price(id),
    prices: async (filter) => operations.prices(filter),
  }
}
