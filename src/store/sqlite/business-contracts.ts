import {
  CONTRACT_KINDS,
  CONTRACT_STATUSES,
  type ContractKind,
  type ContractStatus,
  contractLine,
  type Interval,
  intervalOf,
  type PeriodUnit,
} from "../../domain/business.js"
import { FINANCE_REVIEWS, type FinanceReview } from "../../domain/finance.js"
import { currencyOf, formatDecimal, minorUnits, scaleOf } from "../../domain/money.js"
import type { Decider } from "../decisions.js"
import { type ProposedByFilter, proposedBySql } from "./actors.js"
import { type Author, projectId } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { isoDate, limitOf, oneOf, type Reviewed, refuse, reviewedRowsOver, text, type Written } from "./reviewed.js"
import { write } from "./transaction.js"

export interface Contract extends Reviewed {
  id: string
  ref: string
  /** One line, as a list or the review inbox prints it. */
  title: string
  name: string
  number: string | null
  kind: ContractKind
  status: ContractStatus
  /** `YYYY-MM-DD`. */
  signedDate: string | null
  effectiveDate: string | null
  /** `null` when it runs until ended. */
  expirationDate: string | null
  autoRenew: boolean
  /** What one renewal adds, such as 1-year. */
  renewal: Interval | null
  noticeDays: number | null
  /** The last day to give notice: the expiration date less the notice days; computed, never stored. */
  noticeDeadline: string | null
  terms: string | null
  /** Both `null` when it carries no value. */
  value: string | null
  currency: string | null
  deal: string | null
}

export interface ContractFields {
  name?: string
  number?: string
  kind?: ContractKind
  /** `active` when left out. */
  status?: ContractStatus
  signedDate?: string
  effectiveDate?: string
  expirationDate?: string
  autoRenew?: boolean
  /** A count and a unit, such as 1-year. */
  renewal?: string
  noticeDays?: number
  terms?: string
  /** A decimal string in `currency`; give both or neither. */
  value?: string
  currency?: string
  deal?: string
}

export interface ContractInput extends Written, ContractFields {
  name: string
  kind: ContractKind
}

export interface ContractUpdate extends ContractFields {
  by: Author
}

export interface ContractFilter {
  status?: ContractStatus
  kind?: ContractKind
  project?: string
  review?: FinanceReview
  proposedBy?: ProposedByFilter
  /** `YYYY-MM-DD`: only those that expire on or before it. */
  expiresBy?: string
  /** 1–500, 100 by default; newest written first. */
  limit?: number
}

/**
 * The contracts the owner works under. One without a value is written confirmed by anyone, as it feeds no total: its
 * `confirmedBy` stays `null` and `author` says who wrote it. With a value an agent's waits as proposed. A confirmed
 * contract is the owner's to change.
 */
export interface ContractsStore {
  add(input: ContractInput): Promise<Contract>
  get(reference: string): Promise<Contract>
  list(filter?: ContractFilter): Promise<Contract[]>
  /** The owner changes any; a bot only one it proposed that is still proposed. */
  update(reference: string, input: ContractUpdate): Promise<Contract>
  confirm(reference: string, by: Decider, reason?: string): Promise<Contract>
  reject(reference: string, by: Decider, reason?: string): Promise<Contract>
}

type Row = Record<string, unknown>

const CONTRACTS =
  "SELECT k.*, b.name AS author_name, b.kind AS author_kind FROM contracts k " +
  "LEFT JOIN bots b ON k.author_type = 'bot' AND b.id = k.author_id"

const DAY_MS = 86_400_000

const deadlineOf = (expiration: string | null, days: number | null): string | null =>
  expiration === null || days === null
    ? null
    : new Date(Date.parse(`${expiration}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10)

type ContractOperations = {
  [K in keyof ContractsStore]: ContractsStore[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => R
    : never
}

/** The columns a contract's fields set, checked; a field left out keeps `base`'s value. */
const columnsOf = (fields: ContractFields, base: Row) => {
  const kept = <T>(given: T | undefined, column: string, read: (value: T) => unknown) =>
    given === undefined ? (base[column] ?? null) : read(given)
  const name = kept(fields.name, "name", (value) => text(value, "a contract's name", 200))
  if (name == null) refuse("a contract needs a name", "contract.field")
  const renewal: Interval | null =
    fields.renewal !== undefined
      ? intervalOf(fields.renewal, "contract.field")
      : base.renewal_count == null
        ? null
        : { count: Number(base.renewal_count), unit: base.renewal_unit as PeriodUnit }
  const noticeDays = kept(fields.noticeDays, "notice_days", (value) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 3650)
      refuse("a contract's notice is 0–3650 days", "contract.field")
    return value
  })
  const dates = {
    signed_date: kept(fields.signedDate, "signed_date", (value) => isoDate(value, "a contract's signing date")),
    effective_date: kept(fields.effectiveDate, "effective_date", (value) => isoDate(value, "a contract's start date")),
    expiration_date: kept(fields.expirationDate, "expiration_date", (value) => isoDate(value, "a contract's end date")),
  }
  if (
    dates.effective_date != null &&
    dates.expiration_date != null &&
    String(dates.effective_date) > String(dates.expiration_date)
  )
    refuse("a contract ends on or after the day it starts", "contract.field")
  const valued = fields.value !== undefined || fields.currency !== undefined
  if (valued && (fields.value === undefined) !== (fields.currency === undefined))
    refuse("a contract's value and currency come together", "contract.field")
  const currency = valued ? currencyOf(fields.currency) : ((base.currency as string | undefined) ?? null)
  const value = valued
    ? minorUnits(fields.value, currency as string, "a contract's value")
    : ((base.value as number | undefined) ?? null)
  return {
    name: name as string,
    number: kept(fields.number, "number", (value) => text(value, "a contract's number", 80)),
    kind: kept(fields.kind, "kind", (value) => oneOf(value, CONTRACT_KINDS, "a contract's kind")),
    status: kept(fields.status, "status", (value) => oneOf(value, CONTRACT_STATUSES, "a contract's status")),
    ...dates,
    auto_renew: kept(fields.autoRenew, "auto_renew", (value) => {
      if (typeof value !== "boolean") refuse("a contract's renewal is on or off", "contract.field")
      return value ? 1 : 0
    }),
    renewal_count: renewal?.count ?? null,
    renewal_unit: renewal?.unit ?? null,
    notice_days: noticeDays,
    terms: kept(fields.terms, "terms", (value) => text(value, "a contract's terms", 20_000)),
    value,
    currency,
  }
}

export const contractOperationsOver = (context: StoreContext): ContractOperations => {
  const { database, now } = context
  const { reviewedOf, written, keepEvidence, linkedId, decideRow, mayChangeParts } = reviewedRowsOver(context)

  const contractOf = (row: Row): Contract => {
    const currency = row.currency == null ? null : String(row.currency)
    const value = row.value == null || currency === null ? null : Number(row.value)
    const expirationDate = row.expiration_date == null ? null : String(row.expiration_date)
    const noticeDays = row.notice_days == null ? null : Number(row.notice_days)
    const fields = {
      id: Number(row.id),
      name: String(row.name),
      number: row.number == null ? null : String(row.number),
      value,
      currency,
      status: row.status as ContractStatus,
      review: row.review as FinanceReview,
    }
    return {
      id: String(row.id),
      ref: `contract:${row.id}`,
      title: `Contract ${contractLine(fields)}`,
      name: fields.name,
      number: fields.number,
      kind: row.kind as ContractKind,
      status: fields.status,
      signedDate: row.signed_date == null ? null : String(row.signed_date),
      effectiveDate: row.effective_date == null ? null : String(row.effective_date),
      expirationDate,
      autoRenew: row.auto_renew === 1,
      renewal:
        row.renewal_count == null ? null : { count: Number(row.renewal_count), unit: row.renewal_unit as PeriodUnit },
      noticeDays,
      noticeDeadline: deadlineOf(expirationDate, noticeDays),
      terms: row.terms == null ? null : String(row.terms),
      value: value === null || currency === null ? null : formatDecimal(value, scaleOf(currency)),
      currency,
      deal: row.deal_id == null ? null : `deal:${row.deal_id}`,
      ...reviewedOf(row, "contract"),
    }
  }

  const rowOf = (reference: string): Row => {
    const thing = requiredThing(database, reference.includes(":") ? reference : `contract:${reference}`, "the contract")
    if (thing.type !== "contract") return refuse(`${reference} is not a contract`, "contract.ref")
    return database.prepare(`${CONTRACTS} WHERE k.id = ?`).get(thing.id) as Row
  }

  const decide = (reference: string, by: Decider, reason: string | undefined, confirm: boolean) => {
    const row = rowOf(reference)
    decideRow("contract", row, { by, reason, confirm })
    return contractOf(rowOf(`contract:${row.id}`))
  }

  return {
    add: (input) => {
      const columns = columnsOf({ ...input, status: input.status ?? "active", autoRenew: input.autoRenew ?? false }, {})
      const id = write(database, () => {
        const deal = linkedId(input.deal, "deal", "contract.ref")
        const by = written(input)
        // Without a value a contract feeds no total, so an agent's needs no decision.
        const direct = !by.owner && columns.value === null
        const at = now()
        const made = Number(
          database
            .prepare(
              "INSERT INTO contracts (name, number, kind, status, signed_date, effective_date, expiration_date, auto_renew, " +
                "renewal_count, renewal_unit, notice_days, terms, value, currency, project_id, deal_id, review, author_type, " +
                "author_id, model, confirmed_by_type, confirmed_by_id, source, metadata, created_at, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(
              columns.name,
              columns.number as string | null,
              columns.kind as string,
              columns.status as string,
              columns.signed_date as string | null,
              columns.effective_date as string | null,
              columns.expiration_date as string | null,
              columns.auto_renew as number,
              columns.renewal_count,
              columns.renewal_unit,
              columns.notice_days as number | null,
              columns.terms as string | null,
              columns.value,
              columns.currency,
              by.project,
              deal,
              direct ? "confirmed" : by.review,
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
        keepEvidence("contract", made, by)
        return made
      })
      return contractOf(rowOf(`contract:${id}`))
    },
    get: (reference) => contractOf(rowOf(reference)),
    list: (filter = {}) => {
      const project = filter.project === undefined ? null : projectId(database, filter.project)
      const status = filter.status === undefined ? null : oneOf(filter.status, CONTRACT_STATUSES, "a status")
      const kind = filter.kind === undefined ? null : oneOf(filter.kind, CONTRACT_KINDS, "a kind")
      const review = filter.review === undefined ? null : oneOf(filter.review, FINANCE_REVIEWS, "a review")
      const expires = isoDate(filter.expiresBy, "the last expiration day")
      const by = proposedBySql("k.author_type", "k.author_id", filter.proposedBy)
      return database
        .prepare(
          `${CONTRACTS} WHERE k.deleted_at IS NULL AND (? IS NULL OR k.status = ?) AND (? IS NULL OR k.kind = ?) ` +
            "AND (? IS NULL OR k.review = ?) AND (? IS NULL OR k.project_id = ?) " +
            `AND (? IS NULL OR k.expiration_date <= ?) AND ${by.sql} ORDER BY k.created_at DESC, k.id DESC LIMIT ?`,
        )
        .all(
          status,
          status,
          kind,
          kind,
          review,
          review,
          project,
          project,
          expires,
          expires,
          ...by.params,
          limitOf(filter.limit),
        )
        .map((row) => contractOf(row))
    },
    update: (reference, { by, ...fields }) => {
      const row = rowOf(reference)
      const ref = `contract:${row.id}`
      if (row.review === "rejected" || row.deleted_at != null)
        refuse(`${ref} is ${row.deleted_at != null ? "deleted" : "rejected"}`, "contract.ref")
      mayChangeParts(
        row,
        by,
        `only the owner changes ${ref}; a bot changes only a contract it proposed that is still proposed`,
      )
      const columns = columnsOf(fields, row)
      write(database, () => {
        const deal = fields.deal === undefined ? row.deal_id : linkedId(fields.deal, "deal", "contract.ref")
        database
          .prepare(
            "UPDATE contracts SET name = ?, number = ?, kind = ?, status = ?, signed_date = ?, effective_date = ?, " +
              "expiration_date = ?, auto_renew = ?, renewal_count = ?, renewal_unit = ?, notice_days = ?, terms = ?, " +
              "value = ?, currency = ?, deal_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(
            columns.name,
            columns.number as string | null,
            columns.kind as string,
            columns.status as string,
            columns.signed_date as string | null,
            columns.effective_date as string | null,
            columns.expiration_date as string | null,
            columns.auto_renew as number,
            columns.renewal_count,
            columns.renewal_unit,
            columns.notice_days as number | null,
            columns.terms as string | null,
            columns.value,
            columns.currency,
            deal as number | null,
            now(),
            Number(row.id),
          )
      })
      return contractOf(rowOf(ref))
    },
    confirm: (reference, by, reason) => decide(reference, by, reason, true),
    reject: (reference, by, reason) => decide(reference, by, reason, false),
  }
}

export const contractsStoreOver = (context: StoreContext): ContractsStore => {
  const operations = contractOperationsOver(context)
  return {
    add: async (input) => operations.add(input),
    get: async (reference) => operations.get(reference),
    list: async (filter) => operations.list(filter),
    update: async (reference, input) => operations.update(reference, input),
    confirm: async (reference, by, reason) => operations.confirm(reference, by, reason),
    reject: async (reference, by, reason) => operations.reject(reference, by, reason),
  }
}
