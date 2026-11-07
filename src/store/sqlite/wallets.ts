import { WALLET_KINDS, type WalletKind, walletLine } from "../../domain/business.js"
import { currencyOf, formatDecimal, type Money, moneyOf, scaleOf, signedMinorUnits } from "../../domain/money.js"
import { fold } from "../normalize.js"
import { type Author, authorActor, authorOf } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import {
  type AuthorInfo,
  iso,
  isoDate,
  limitOf,
  oneOf,
  type Party,
  refuse,
  reviewedRowsOver,
  text,
} from "./reviewed.js"
import { write } from "./transaction.js"

export interface Wallet {
  id: string
  ref: string
  /** One line, as a list prints it. */
  title: string
  name: string
  kind: WalletKind
  currency: string
  institution: string | null
  /** The last 4 characters of its number. */
  numberHint: string | null
  /** Whose it is, when not the owner's. */
  holder: Party | null
  /** Signed; both `null` until the owner sets them. */
  openingBalance: string | null
  openingDate: string | null
  closedDate: string | null
  /**
   * The opening balance plus confirmed, booked transactions after the opening day and up to `until`: computed each
   * time, never stored.
   */
  balance: Money
  /** `YYYY-MM-DD`: the last day the balance counts. */
  until: string
  /** Pending or proposed transactions up to `until`, signed: shown beside the balance, never in it. */
  pending: Money
  author: AuthorInfo
  model: string | null
  source: string
  createdAt: string
  updatedAt: string
}

export interface WalletInput {
  /** The owner and an agent write alike, except the opening balance: only the owner sets it. */
  by: Author
  name: string
  /** One currency per wallet: a bank account in two currencies is two wallets. */
  currency: string
  /** `bank` when left out. */
  kind?: WalletKind
  institution?: string
  /** The last 4 characters of the number; a whole IBAN or card number is refused. */
  numberHint?: string
  holder?: string
  /** A signed decimal string, with its day; give both or neither. */
  openingBalance?: string
  openingDate?: string
  source?: string
}

export interface WalletUpdate {
  by: Author
  name?: string
  institution?: string | null
  numberHint?: string | null
  closedDate?: string | null
  /** The owner's only. Give both, or `null` for both to clear them. */
  openingBalance?: string | null
  openingDate?: string | null
}

export interface WalletFilter {
  kind?: WalletKind
  currency?: string
  /** `true` only closed ones, `false` only open ones; both when left out. */
  closed?: boolean
  /** 1–500, 100 by default; by name. */
  limit?: number
}

/** Bank accounts, cards, cash and wallets (`wallet:<id>`), written directly; their balances are computed. */
export interface WalletsStore {
  add(input: WalletInput): Promise<Wallet>
  /** `until` is `YYYY-MM-DD`, today when left out. */
  get(reference: string, options?: { until?: string }): Promise<Wallet>
  list(filter?: WalletFilter): Promise<Wallet[]>
  update(reference: string, input: WalletUpdate): Promise<Wallet>
}

type Row = Record<string, unknown>

const WALLETS =
  "SELECT w.*, b.name AS author_name, b.kind AS author_kind FROM financial_accounts w " +
  "LEFT JOIN bots b ON w.author_type = 'bot' AND b.id = w.author_id"

const SIGNED = "CASE t.direction WHEN 'in' THEN t.amount ELSE -t.amount END"

type WalletOperations = {
  [K in keyof WalletsStore]: WalletsStore[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never
}

export const walletOperationsOver = (context: StoreContext): WalletOperations => {
  const { database, now } = context
  const { partyOf, partyThing } = reviewedRowsOver(context)
  const today = () => new Date(now()).toISOString().slice(0, 10)

  const sumOf = (sql: string, ...params: (string | number | null)[]) =>
    Number(
      database
        .prepare(`SELECT coalesce(sum(${SIGNED}), 0) AS n FROM financial_transactions t WHERE ${sql}`)
        .get(...params)?.n,
    )

  const walletOf = (row: Row, until: string): Wallet => {
    const currency = String(row.currency)
    const scale = scaleOf(currency)
    const opening = row.opening_balance == null ? null : Number(row.opening_balance)
    const openingDate = row.opening_date == null ? null : String(row.opening_date)
    const booked = sumOf(
      "t.financial_account_id = ? AND t.review = 'confirmed' AND t.status = 'booked' AND t.deleted_at IS NULL " +
        "AND (? IS NULL OR t.booked_date > ?) AND t.booked_date <= ?",
      Number(row.id),
      openingDate,
      openingDate,
      until,
    )
    const pending = sumOf(
      "t.financial_account_id = ? AND t.deleted_at IS NULL AND t.review <> 'rejected' " +
        "AND (t.status = 'pending' OR t.review = 'proposed') AND t.statement_date <= ?",
      Number(row.id),
      until,
    )
    const fields = {
      name: String(row.name),
      kind: row.kind as WalletKind,
      currency,
      numberHint: row.number_hint == null ? null : String(row.number_hint),
      closed: row.closed_date != null,
    }
    return {
      id: String(row.id),
      ref: `wallet:${row.id}`,
      title: walletLine(fields),
      name: fields.name,
      kind: fields.kind,
      currency,
      institution: row.institution == null ? null : String(row.institution),
      numberHint: fields.numberHint,
      holder: partyOf(row.holder_type, row.holder_id),
      openingBalance: opening === null ? null : formatDecimal(opening, scale),
      openingDate,
      closedDate: row.closed_date == null ? null : String(row.closed_date),
      balance: moneyOf((opening ?? 0) + booked, currency),
      until,
      pending: moneyOf(pending, currency),
      author: authorOf(row),
      model: row.model == null ? null : String(row.model),
      source: String(row.source),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }
  }

  const rowOf = (reference: string): Row => {
    const thing = requiredThing(database, reference.includes(":") ? reference : `wallet:${reference}`, "the wallet")
    if (thing.type !== "wallet") return refuse(`${reference} is not a wallet`, "wallet.ref")
    return database.prepare(`${WALLETS} WHERE w.id = ?`).get(thing.id) as Row
  }

  const hintOf = (value: string | null | undefined) => {
    const hint = text(value, "a wallet's number", 64)
    if (hint !== null && hint.replace(/\s/g, "").length > 4)
      refuse("a wallet keeps only the last 4 characters of its number, never the whole of it", "wallet.number")
    return hint === null ? null : hint.replace(/\s/g, "")
  }

  const openingOf = (
    by: Author,
    balance: string | null | undefined,
    date: string | null | undefined,
    currency: string,
  ) => {
    if (balance === undefined && date === undefined) return undefined
    if (by !== "owner")
      refuse("only the owner sets a wallet's opening balance", "finance.owner-only", "permission_error")
    if ((balance == null) !== (date == null)) refuse("an opening balance comes with its day", "wallet.field")
    if (balance == null || date == null) return { units: null, date: null }
    return {
      units: signedMinorUnits(balance, currency, "an opening balance"),
      date: isoDate(date, "the opening day") as string,
    }
  }

  return {
    add: (input) => {
      const kind = input.kind === undefined ? "bank" : oneOf(input.kind, WALLET_KINDS, "a wallet's kind")
      const currency = currencyOf(input.currency)
      const name = text(input.name, "a wallet's name", 200) ?? refuse("a wallet needs a name", "wallet.field")
      const hint = hintOf(input.numberHint)
      const institution = text(input.institution, "a wallet's bank", 200)
      const opening = openingOf(input.by, input.openingBalance, input.openingDate, currency)
      const id = write(database, () => {
        const holder = partyThing(input.holder, "the holder")
        const { actor, model } = authorActor(context, input.by)
        const source = input.by === "owner" ? "owner" : (text(input.source, "a source", 80) ?? "agent")
        const at = now()
        return Number(
          database
            .prepare(
              "INSERT INTO financial_accounts (name, name_folded, kind, currency, institution, number_hint, holder_type, " +
                "holder_id, opening_balance, opening_date, author_type, author_id, model, source, created_at, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(
              name,
              fold(name),
              kind,
              currency,
              institution,
              hint,
              holder?.type ?? null,
              holder?.id ?? null,
              opening?.units ?? null,
              opening?.date ?? null,
              actor.type,
              actor.id,
              model,
              source,
              at,
              at,
            )?.id,
        )
      })
      return walletOf(rowOf(`wallet:${id}`), today())
    },
    get: (reference, options = {}) =>
      walletOf(rowOf(reference), isoDate(options.until, "the last day counted") ?? today()),
    list: (filter = {}) => {
      const kind = filter.kind === undefined ? null : oneOf(filter.kind, WALLET_KINDS, "a kind")
      const currency = filter.currency === undefined ? null : currencyOf(filter.currency)
      const closed = filter.closed === undefined ? null : filter.closed ? 1 : 0
      return database
        .prepare(
          `${WALLETS} WHERE w.deleted_at IS NULL AND (? IS NULL OR w.kind = ?) AND (? IS NULL OR w.currency = ?) ` +
            "AND (? IS NULL OR (w.closed_date IS NOT NULL) = ?) ORDER BY w.name_folded, w.id LIMIT ?",
        )
        .all(kind, kind, currency, currency, closed, closed, limitOf(filter.limit))
        .map((row) => walletOf(row, today()))
    },
    update: (reference, input) => {
      const row = rowOf(reference)
      if (row.deleted_at != null) refuse(`wallet:${row.id} is deleted`, "wallet.ref")
      authorActor(context, input.by)
      const opening = openingOf(input.by, input.openingBalance, input.openingDate, String(row.currency))
      const name = input.name === undefined ? String(row.name) : (text(input.name, "a wallet's name", 200) as string)
      const institution =
        input.institution === undefined ? row.institution : text(input.institution, "a wallet's bank", 200)
      const hint = input.numberHint === undefined ? row.number_hint : hintOf(input.numberHint)
      const closed = input.closedDate === undefined ? row.closed_date : isoDate(input.closedDate, "the closing day")
      write(database, () => {
        database
          .prepare(
            "UPDATE financial_accounts SET name = ?, name_folded = ?, institution = ?, number_hint = ?, closed_date = ?, " +
              "opening_balance = ?, opening_date = ?, updated_at = ? WHERE id = ?",
          )
          .run(
            name,
            fold(name),
            institution as string | null,
            hint as string | null,
            closed as string | null,
            opening === undefined ? (row.opening_balance as number | null) : opening.units,
            opening === undefined ? (row.opening_date as string | null) : opening.date,
            now(),
            Number(row.id),
          )
      })
      return walletOf(rowOf(`wallet:${row.id}`), today())
    },
  }
}

export const walletsStoreOver = (context: StoreContext): WalletsStore => {
  const operations = walletOperationsOver(context)
  return {
    add: async (input) => operations.add(input),
    get: async (reference, options) => operations.get(reference, options),
    list: async (filter) => operations.list(filter),
    update: async (reference, input) => operations.update(reference, input),
  }
}
