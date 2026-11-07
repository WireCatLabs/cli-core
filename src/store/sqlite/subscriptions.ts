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
import { type Author, authorOf, projectId } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import {
  type AuthorInfo,
  iso,
  isoDate,
  limitOf,
  oneOf,
  type Party,
  type Reviewed,
  reasonOf,
  refuse,
  reviewedRowsOver,
  text,
  type Written,
} from "./reviewed.js"
import { write } from "./transaction.js"

export interface SubscriptionPrice extends Money {
  id: string
  /** `subscription_price:<id>`: its own proposal, never changed once written. */
  ref: string
  /** One line, as the review inbox prints it. */
  title: string
  subscription: string
  /** `YYYY-MM-DD`: the first day it is billed. */
  effectiveFrom: string
  review: FinanceReview
  author: AuthorInfo
  reason: string | null
  /** Always `null`: a price belongs to its subscription's project. */
  project: null
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

export interface SubscriptionFields {
  name?: string
  direction?: InvoiceDirection
  /** The owner's own person when left out of a receivable one. */
  supplier?: string
  /** The owner's own person when left out of a payable one. */
  customer?: string
  /** `null` takes it off. */
  product?: string | null
  contract?: string | null
  /** `trial` when a trial end is given, else `active`. */
  status?: SubscriptionStatus
  /** A count and a unit, such as 1-month, as `--every` takes it. */
  every?: string
  startDate?: string
  trialEndDate?: string | null
  nextRenewalDate?: string | null
  /** Today when it is cancelled and no day is given. */
  cancelledDate?: string | null
  endDate?: string | null
}

export interface SubscriptionInput extends Written, SubscriptionFields {
  direction: InvoiceDirection
  every: string
  startDate: string
  /** Its prices, proposed or confirmed with the subscription. */
  prices?: PriceInput[]
}

export interface SubscriptionUpdate extends SubscriptionFields {
  by: Author
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

export interface PriceFilter {
  review?: FinanceReview
  proposedBy?: ProposedByFilter
  /** 1–500, 100 by default; newest written first. */
  limit?: number
}

/**
 * Subscriptions the owner bills or pays, and their prices. A price is a row of its own and never changes. Confirming a
 * subscription confirms the prices proposed with it; a later price is a proposal of its own, and the subscription
 * stays confirmed.
 */
export interface SubscriptionsStore {
  add(input: SubscriptionInput): Promise<SubscriptionDetail>
  get(reference: string): Promise<SubscriptionDetail>
  list(filter?: SubscriptionFilter): Promise<Subscription[]>
  /** The owner changes any; a bot only one it proposed that is still proposed. */
  update(reference: string, input: SubscriptionUpdate): Promise<SubscriptionDetail>
  addPrice(reference: string, input: PriceInput & Omit<Written, "project" | "evidence">): Promise<SubscriptionPrice>
  /** `subscription:<id>` or `subscription_price:<id>`. */
  confirm(reference: string, by: Decider, reason?: string): Promise<SubscriptionDetail>
  reject(reference: string, by: Decider, reason?: string): Promise<SubscriptionDetail>
  /** `subscription_price:<id>`. */
  price(reference: string): Promise<SubscriptionPrice>
  /** Proposed or decided prices, newest written first, as the review inbox lists them. */
  prices(filter?: PriceFilter): Promise<SubscriptionPrice[]>
}

type Row = Record<string, unknown>

const SUBSCRIPTIONS =
  "SELECT s.*, b.name AS author_name, b.kind AS author_kind FROM subscriptions s " +
  "LEFT JOIN bots b ON s.author_type = 'bot' AND b.id = s.author_id"
const PRICES =
  "SELECT p.*, b.name AS author_name, b.kind AS author_kind FROM subscription_prices p " +
  "LEFT JOIN bots b ON p.author_type = 'bot' AND b.id = p.author_id"
const PRICE_REF = /^subscription_price:([1-9]\d{0,15})$/

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
    const amount = formatDecimal(Number(row.amount), scaleOf(currency))
    const subscription = `subscription:${row.subscription_id}`
    return {
      id: String(row.id),
      ref: `subscription_price:${row.id}`,
      title: `Price of ${subscription}: ${amount} ${currency} from ${row.effective_from}`,
      subscription,
      amount,
      currency,
      effectiveFrom: String(row.effective_from),
      review: row.review as FinanceReview,
      author: authorOf(row),
      reason: reasonOf(row.metadata),
      project: null,
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

  const priceRowOf = (reference: string): Row => {
    const match = PRICE_REF.exec(reference.trim())
    const row = match ? database.prepare(`${PRICES} WHERE p.id = ?`).get(Number(match[1])) : undefined
    if (!row) throw new CliError("not_found", `no subscription price ${reference}`, { reason: "subscription.no-price" })
    return row
  }

  const detailOf = (reference: string): SubscriptionDetail => {
    const row = rowOf(reference)
    return { ...subscriptionOf(row), prices: pricesOf(Number(row.id)) }
  }

  /** The columns a subscription's fields set, checked; a field left out keeps `base`'s value. Runs in a write. */
  const columnsOf = (fields: SubscriptionFields, base: Row) => {
    const kept = <T>(given: T | undefined, column: string, read: (value: T) => unknown) =>
      given === undefined ? (base[column] ?? null) : read(given)
    const day = (given: string | null | undefined, column: string, what: string) =>
      kept(given, column, (value) => isoDate(value, what)) as string | null
    const direction = kept(fields.direction, "direction", (value) =>
      oneOf(value, INVOICE_DIRECTIONS, "a subscription's direction"),
    ) as InvoiceDirection
    const interval =
      fields.every === undefined
        ? { count: Number(base.interval_count), unit: base.interval_unit as PeriodUnit }
        : intervalOf(fields.every)
    const start =
      day(fields.startDate, "start_date", "a subscription's start") ??
      refuse("a subscription starts on a day", "subscription.field")
    const trial = day(fields.trialEndDate, "trial_end_date", "a trial's end")
    const status = kept(fields.status, "status", (value) =>
      oneOf(value, SUBSCRIPTION_STATUSES, "a subscription's status"),
    ) as SubscriptionStatus | null
    const settled = status ?? (trial === null ? "active" : "trial")
    const cancelled =
      fields.cancelledDate === undefined && settled === "cancelled" && base.cancelled_date == null
        ? today()
        : day(fields.cancelledDate, "cancelled_date", "the day it was cancelled")
    const end = day(fields.endDate, "end_date", "a subscription's end")
    if (trial !== null && trial < start)
      refuse("a trial ends on or after the subscription starts", "subscription.field")
    if (end !== null && end < start) refuse("a subscription ends on or after it starts", "subscription.field")
    if (settled === "trial" && trial === null) refuse("a subscription in trial has a trial end", "subscription.field")
    if (settled === "cancelled" && cancelled === null)
      refuse("a cancelled subscription has the day it was cancelled", "subscription.field")
    const owner = ownerPerson(database)
    const party = (given: string | undefined, type: string, id: string, ownerSide: boolean, what: string) =>
      given !== undefined
        ? (partyThing(given, what) as { type: string; id: number })
        : base[type] != null
          ? { type: String(base[type]), id: Number(base[id]) }
          : ownerSide
            ? owner
            : refuse(
                "a subscription names its supplier and its customer, a person: or organization:",
                "subscription.field",
              )
    const supplier = party(fields.supplier, "supplier_type", "supplier_id", direction === "receivable", "the supplier")
    const customer = party(fields.customer, "customer_type", "customer_id", direction === "payable", "the customer")
    const linked = (given: string | null | undefined, type: "product" | "contract", column: string) =>
      given === undefined
        ? ((base[column] as number | null | undefined) ?? null)
        : given === null
          ? null
          : linkedId(given, type, "subscription.ref")
    const product = linked(fields.product, "product", "catalog_item_id")
    const productName =
      product === null
        ? null
        : String(database.prepare("SELECT name FROM catalog_items WHERE id = ?").get(product)?.name)
    const name =
      kept(fields.name, "name", (value) => text(value, "a subscription's name", 200)) ??
      productName ??
      refuse("a subscription needs a name, or a product to take it from", "subscription.field")
    return {
      name: String(name),
      direction,
      supplier_type: supplier.type,
      supplier_id: supplier.id,
      customer_type: customer.type,
      customer_id: customer.id,
      catalog_item_id: product,
      contract_id: linked(fields.contract, "contract", "contract_id"),
      status: settled,
      interval_count: interval.count,
      interval_unit: interval.unit,
      start_date: start,
      trial_end_date: trial,
      next_renewal_date: day(fields.nextRenewalDate, "next_renewal_date", "the next renewal"),
      cancelled_date: cancelled,
      end_date: end,
    }
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

  const decidePrice = (reference: string, by: Decider, reason: string | undefined, confirm: boolean) => {
    const price = priceRowOf(reference)
    const parent = rowOf(`subscription:${price.subscription_id}`)
    decideRow(
      "subscription_price",
      price,
      { by, reason, confirm },
      {
        before: () => {
          if (confirm && parent.review !== "confirmed")
            refuse(
              `subscription:${parent.id} is ${String(parent.review)}; confirm the subscription before its price`,
              "subscription.price",
            )
        },
      },
    )
    return detailOf(`subscription:${parent.id}`)
  }

  const decide = (reference: string, by: Decider, reason: string | undefined, confirm: boolean) => {
    if (PRICE_REF.test(reference.trim())) return decidePrice(reference, by, reason, confirm)
    const row = rowOf(reference)
    decideRow(
      "subscription",
      row,
      { by, reason, confirm },
      {
        // The prices still proposed came with the subscription: they go with its decision.
        after: (confirmer) =>
          database
            .prepare(
              "UPDATE subscription_prices SET review = ?, confirmed_by_type = ?, confirmed_by_id = ?, updated_at = ? " +
                "WHERE subscription_id = ? AND review = 'proposed'",
            )
            .run(
              confirmer ? "confirmed" : "rejected",
              confirmer?.type ?? null,
              confirmer?.id ?? null,
              now(),
              Number(row.id),
            ),
      },
    )
    return detailOf(`subscription:${row.id}`)
  }

  const writable = (row: Row, by: Author) => {
    const ref = `subscription:${row.id}`
    if (row.review === "rejected" || row.deleted_at != null)
      refuse(`${ref} is ${row.deleted_at != null ? "deleted" : "rejected"}`, "subscription.ref")
    mayChangeParts(
      row,
      by,
      `only the owner changes ${ref}; a bot changes only a subscription it proposed that is still proposed`,
    )
  }

  return {
    add: (input) => {
      if (input.prices !== undefined && (!Array.isArray(input.prices) || input.prices.length > 100))
        refuse("a subscription takes at most 100 prices", "subscription.field")
      const id = write(database, () => {
        const columns = columnsOf(input, {})
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
              columns.name,
              columns.direction,
              columns.supplier_type,
              columns.supplier_id,
              columns.customer_type,
              columns.customer_id,
              columns.catalog_item_id,
              columns.contract_id,
              by.project,
              columns.status,
              columns.interval_count,
              columns.interval_unit,
              columns.start_date,
              columns.trial_end_date,
              columns.next_renewal_date,
              columns.cancelled_date,
              columns.end_date,
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
        for (const price of input.prices ?? []) insertPrice(made, price, columns.start_date, by)
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
          limitOf(filter.limit),
        )
        .map(subscriptionOf)
    },
    update: (reference, { by, ...fields }) => {
      const row = rowOf(reference)
      writable(row, by)
      write(database, () => {
        const columns = columnsOf(fields, row)
        database
          .prepare(
            "UPDATE subscriptions SET name = ?, direction = ?, supplier_type = ?, supplier_id = ?, customer_type = ?, " +
              "customer_id = ?, catalog_item_id = ?, contract_id = ?, status = ?, interval_count = ?, interval_unit = ?, " +
              "start_date = ?, trial_end_date = ?, next_renewal_date = ?, cancelled_date = ?, end_date = ?, updated_at = ? " +
              "WHERE id = ?",
          )
          .run(
            columns.name,
            columns.direction,
            columns.supplier_type,
            columns.supplier_id,
            columns.customer_type,
            columns.customer_id,
            columns.catalog_item_id,
            columns.contract_id,
            columns.status,
            columns.interval_count,
            columns.interval_unit,
            columns.start_date,
            columns.trial_end_date,
            columns.next_renewal_date,
            columns.cancelled_date,
            columns.end_date,
            now(),
            Number(row.id),
          )
      })
      return detailOf(`subscription:${row.id}`)
    },
    addPrice: (reference, input) => {
      const row = rowOf(reference)
      if (row.review === "rejected" || row.deleted_at != null)
        refuse(`subscription:${row.id} is ${row.deleted_at != null ? "deleted" : "rejected"}`, "subscription.ref")
      // A price on a proposed subscription is part of that proposal, so only its author or the owner adds one.
      if (row.review === "proposed") writable(row, input.by)
      const id = write(database, () => insertPrice(Number(row.id), input, String(row.start_date), written(input)))
      return priceOf(database.prepare(`${PRICES} WHERE p.id = ?`).get(id) as Row)
    },
    confirm: (reference, by, reason) => decide(reference, by, reason, true),
    reject: (reference, by, reason) => decide(reference, by, reason, false),
    price: (reference) => priceOf(priceRowOf(reference)),
    prices: (filter = {}) => {
      const review = filter.review === undefined ? null : oneOf(filter.review, FINANCE_REVIEWS, "a review")
      const by = proposedBySql("p.author_type", "p.author_id", filter.proposedBy)
      return database
        .prepare(
          `${PRICES} WHERE (? IS NULL OR p.review = ?) AND ${by.sql} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
        )
        .all(review, review, ...by.params, limitOf(filter.limit))
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
    price: async (reference) => operations.price(reference),
    prices: async (filter) => operations.prices(filter),
  }
}
