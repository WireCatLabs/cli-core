import { CliError } from "@wirecat/cli-base"
import { TRANSACTION_STATUSES, type TransactionStatus, transactionLine } from "../../domain/business.js"
import { FINANCE_REVIEWS, type FinanceReview, MONEY_DIRECTIONS, type MoneyDirection } from "../../domain/finance.js"
import { formatDecimal, type Money, minorUnits, moneyLabel, moneyOf, scaleOf } from "../../domain/money.js"
import type { Decider } from "../decisions.js"
import { fold } from "../normalize.js"
import { type ProposedByFilter, proposedBySql } from "./actors.js"
import { isoDate, oneOf, type Party, type Reviewed, refuse, reviewedRowsOver, text, type Written } from "./finance.js"
import { type Author, projectId } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

export interface TransactionSplit {
  position: number
  category: string
  amount: string
  project: string | null
  note: string | null
}

export interface MoneyTransaction extends Reviewed {
  id: string
  ref: string
  /** One line, as a list or the review inbox prints it. */
  title: string
  wallet: string
  walletName: string
  direction: MoneyDirection
  amount: string
  currency: string
  status: TransactionStatus
  /** `YYYY-MM-DD`: the day the statement shows. */
  date: string
  /** Set once booked. */
  bookedDate: string | null
  description: string | null
  /** As the statement names the other side. */
  counterpartyName: string | null
  counterparty: Party | null
  reference: string | null
  /** The payment it settles, of the same currency, direction and amount. */
  payment: string | null
  splits: TransactionSplit[]
  /** What no split categorizes. */
  uncategorized: string
}

export interface SplitInput {
  /** A decimal string in the transaction's currency. */
  amount: string
  category: string
  project?: string
  note?: string
}

export interface TransactionInput extends Written {
  wallet: string
  direction: MoneyDirection
  /** A decimal string above 0, in the wallet's currency. */
  amount: string
  /** The wallet's; refused when it differs. */
  currency?: string
  /** `booked` when left out. */
  status?: TransactionStatus
  date: string
  /** A booked transaction's day; its `date` when left out. */
  bookedDate?: string
  description?: string
  counterpartyName?: string
  counterparty?: string
  reference?: string
  payment?: string
  splits?: SplitInput[]
}

export interface TransactionUpdate {
  by: Author
  status?: TransactionStatus
  bookedDate?: string
  /** `null` takes the link back. */
  payment?: string | null
  counterparty?: string | null
}

export interface TransactionFilter {
  wallet?: string
  direction?: MoneyDirection
  status?: TransactionStatus
  /** A split's category, in any letter case. */
  category?: string
  project?: string
  review?: FinanceReview
  proposedBy?: ProposedByFilter
  /** Only those with an amount no split categorizes. */
  uncategorized?: boolean
  /** 1–500, 100 by default; latest statement day first. */
  limit?: number
}

export interface CategoryTotal extends Money {
  /** `null` for what no split categorizes. */
  category: string | null
}

/**
 * What statements say moved on the owner's wallets (`transaction:<id>`). An agent's or an import's waits as proposed;
 * a payment is linked only when currency, direction and amount agree, one transaction per payment.
 */
export interface TransactionsStore {
  add(input: TransactionInput): Promise<MoneyTransaction>
  get(reference: string): Promise<MoneyTransaction>
  list(filter?: TransactionFilter): Promise<MoneyTransaction[]>
  update(reference: string, input: TransactionUpdate): Promise<MoneyTransaction>
  addSplit(reference: string, input: SplitInput & { by: Author }): Promise<MoneyTransaction>
  removeSplit(reference: string, input: { position: number; by: Author }): Promise<MoneyTransaction>
  /** Totals per category and currency over confirmed, booked transactions; nothing is converted. */
  categories(filter?: { wallet?: string; from?: string; until?: string }): Promise<CategoryTotal[]>
  confirm(reference: string, by: Decider, reason?: string): Promise<MoneyTransaction>
  reject(reference: string, by: Decider, reason?: string): Promise<MoneyTransaction>
}

type Row = Record<string, unknown>

const TRANSACTIONS =
  "SELECT t.*, w.name AS wallet_name, b.name AS author_name, b.kind AS author_kind, " +
  "(SELECT coalesce(sum(amount), 0) FROM transaction_splits WHERE transaction_id = t.id) AS split " +
  "FROM financial_transactions t JOIN financial_accounts w ON w.id = t.financial_account_id " +
  "LEFT JOIN bots b ON t.author_type = 'bot' AND b.id = t.author_id"

const MAX_SPLITS = 100

type TransactionOperations = {
  [K in keyof TransactionsStore]: TransactionsStore[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => R
    : never
}

export const transactionOperationsOver = (context: StoreContext): TransactionOperations => {
  const { database, now } = context
  const { partyOf, partyThing, reviewedOf, written, keepEvidence, linkedId, decideRow, mayChangeParts } =
    reviewedRowsOver(context)

  const splitsOf = (id: number, currency: string): TransactionSplit[] =>
    database
      .prepare("SELECT * FROM transaction_splits WHERE transaction_id = ? ORDER BY position")
      .all(id)
      .map((row) => ({
        position: Number(row.position),
        category: String(row.category),
        amount: formatDecimal(Number(row.amount), scaleOf(currency)),
        project: row.project_id == null ? null : `project:${row.project_id}`,
        note: row.note == null ? null : String(row.note),
      }))

  const transactionOf = (row: Row): MoneyTransaction => {
    const currency = String(row.currency)
    const scale = scaleOf(currency)
    const amount = Number(row.amount)
    const fields = {
      direction: row.direction as MoneyDirection,
      amount,
      currency,
      label: (row.counterparty_name ?? row.description ?? null) as string | null,
      date: String(row.statement_date),
      status: row.status as TransactionStatus,
      review: row.review as FinanceReview,
    }
    return {
      id: String(row.id),
      ref: `transaction:${row.id}`,
      title: `Transaction · ${transactionLine(fields)}`,
      wallet: `wallet:${row.financial_account_id}`,
      walletName: String(row.wallet_name),
      direction: fields.direction,
      amount: formatDecimal(amount, scale),
      currency,
      status: fields.status,
      date: fields.date,
      bookedDate: row.booked_date == null ? null : String(row.booked_date),
      description: row.description == null ? null : String(row.description),
      counterpartyName: row.counterparty_name == null ? null : String(row.counterparty_name),
      counterparty: partyOf(row.counterparty_type, row.counterparty_id),
      reference: row.reference == null ? null : String(row.reference),
      payment: row.payment_id == null ? null : `payment:${row.payment_id}`,
      splits: splitsOf(Number(row.id), currency),
      uncategorized: formatDecimal(amount - Number(row.split), scale),
      ...reviewedOf(row, "transaction"),
    }
  }

  const rowOf = (reference: string): Row => {
    const thing = requiredThing(
      database,
      reference.includes(":") ? reference : `transaction:${reference}`,
      "the transaction",
    )
    if (thing.type !== "transaction") return refuse(`${reference} is not a transaction`, "transaction.ref")
    return database.prepare(`${TRANSACTIONS} WHERE t.id = ?`).get(thing.id) as Row
  }

  /** A statement line meets the settlement it records only when both say the same: currency, direction, amount. */
  const paymentFor = (
    reference: string | null | undefined,
    moved: { direction: string; amount: number; currency: string },
    except: number | null,
  ): number | null => {
    if (reference == null) return null
    const id = linkedId(reference, "payment", "transaction.payment") as number
    const payment = database.prepare("SELECT * FROM payments WHERE id = ?").get(id) as Row
    const ref = `payment:${id}`
    if (payment.review === "rejected" || payment.deleted_at != null)
      refuse(`${ref} is ${payment.review === "rejected" ? "rejected" : "deleted"}`, "transaction.payment")
    if (
      payment.currency !== moved.currency ||
      payment.direction !== moved.direction ||
      Number(payment.amount) !== moved.amount
    )
      refuse(
        `${ref} is ${moneyLabel(Number(payment.amount), String(payment.currency))} ${String(payment.direction)}; ` +
          `the transaction is ${moneyLabel(moved.amount, moved.currency)} ${moved.direction}: they are not the same money`,
        "transaction.payment",
      )
    const taken = database
      .prepare("SELECT id FROM financial_transactions WHERE payment_id = ? AND deleted_at IS NULL AND id IS NOT ?")
      .get(id, except)
    if (taken) refuse(`${ref} is already the payment of transaction:${taken.id}`, "transaction.payment")
    return id
  }

  const splitRows = (splits: SplitInput[], currency: string, amount: number, already: number) => {
    if (!Array.isArray(splits) || splits.length > MAX_SPLITS)
      refuse(`a transaction has at most ${MAX_SPLITS} splits`, "transaction.split")
    const rows = splits.map((split, at) => {
      const what = `split ${at + 1}`
      const units = minorUnits(split.amount, currency, `${what}'s amount`)
      if (units <= 0) refuse(`${what}'s amount is more than 0`, "money.amount")
      return {
        units,
        category:
          text(split.category, `${what}'s category`, 200) ?? refuse(`${what} needs a category`, "transaction.split"),
        project: split.project === undefined ? null : projectId(database, split.project),
        note: text(split.note, `${what}'s note`, 2000),
      }
    })
    const total = already + rows.reduce((sum, row) => sum + row.units, 0)
    if (total > amount)
      refuse(
        `the splits come to ${moneyLabel(total, currency)}, more than the transaction's ${moneyLabel(amount, currency)}`,
        "transaction.split",
      )
    return rows
  }

  const insertSplits = (id: number, rows: ReturnType<typeof splitRows>, from: number) => {
    const at = now()
    const insert = database.prepare(
      "INSERT INTO transaction_splits (transaction_id, position, category, category_folded, amount, project_id, note, " +
        "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    for (const [index, row] of rows.entries())
      insert.run(id, from + index, row.category, fold(row.category), row.units, row.project, row.note, at, at)
  }

  const mayChange = (row: Row, by: Author) => {
    mayChangeParts(
      row,
      by,
      `only the owner changes transaction:${row.id}; a bot changes only a transaction it proposed that is still proposed`,
    )
    if (row.review === "rejected" || row.deleted_at != null)
      refuse(`transaction:${row.id} is ${row.deleted_at != null ? "deleted" : "rejected"}`, "transaction.ref")
  }

  const bookingOf = (status: TransactionStatus, booked: string | null | undefined, date: string) => {
    if (status === "pending" && booked != null)
      refuse("a pending transaction has no booking day yet", "transaction.field")
    return status === "pending" ? null : (isoDate(booked, "the booking day") ?? date)
  }

  const decide = (reference: string, by: Decider, reason: string | undefined, confirm: boolean) => {
    const row = rowOf(reference)
    decideRow("transaction", row, { by, reason, confirm })
    return transactionOf(rowOf(`transaction:${row.id}`))
  }

  return {
    add: (input) => {
      const direction = oneOf(input.direction, MONEY_DIRECTIONS, "a transaction's direction")
      const status = input.status === undefined ? "booked" : oneOf(input.status, TRANSACTION_STATUSES, "a status")
      const date = isoDate(input.date, "a transaction's day") ?? refuse("a transaction has a day", "transaction.field")
      const bookedDate = bookingOf(status, input.bookedDate, date)
      const id = write(database, () => {
        const walletId = linkedId(input.wallet, "wallet", "transaction.ref") as number
        const wallet = database.prepare("SELECT * FROM financial_accounts WHERE id = ?").get(walletId) as Row
        if (wallet.deleted_at != null) refuse(`wallet:${walletId} is deleted`, "transaction.ref")
        const currency = String(wallet.currency)
        if (input.currency !== undefined && input.currency.trim().toUpperCase() !== currency)
          refuse(`wallet:${walletId} is in ${currency}; a transaction is in its wallet's currency`, "money.currency")
        const amount = minorUnits(input.amount, currency, "a transaction's amount")
        if (amount <= 0) refuse("a transaction's amount is more than 0", "money.amount")
        const splits = splitRows(input.splits ?? [], currency, amount, 0)
        const payment = paymentFor(input.payment, { direction, amount, currency }, null)
        const counterparty = partyThing(input.counterparty, "the counterparty")
        const by = written(input)
        const at = now()
        const made = Number(
          database
            .prepare(
              "INSERT INTO financial_transactions (financial_account_id, direction, amount, currency, status, statement_date, " +
                "booked_date, description, counterparty_name, counterparty_type, counterparty_id, reference, payment_id, " +
                "project_id, review, author_type, author_id, model, confirmed_by_type, confirmed_by_id, source, metadata, " +
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
                "RETURNING id",
            )
            .get(
              walletId,
              direction,
              amount,
              currency,
              status,
              date,
              bookedDate,
              text(input.description, "a transaction's description", 2000),
              text(input.counterpartyName, "the counterparty's name", 200),
              counterparty?.type ?? null,
              counterparty?.id ?? null,
              text(input.reference, "a transaction's reference", 500),
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
        insertSplits(made, splits, 1)
        keepEvidence("transaction", made, by)
        return made
      })
      return transactionOf(rowOf(`transaction:${id}`))
    },
    get: (reference) => transactionOf(rowOf(reference)),
    list: (filter = {}) => {
      const wallet = filter.wallet === undefined ? null : linkedId(filter.wallet, "wallet", "transaction.ref")
      const project = filter.project === undefined ? null : projectId(database, filter.project)
      const direction = filter.direction === undefined ? null : oneOf(filter.direction, MONEY_DIRECTIONS, "a direction")
      const status = filter.status === undefined ? null : oneOf(filter.status, TRANSACTION_STATUSES, "a status")
      const review = filter.review === undefined ? null : oneOf(filter.review, FINANCE_REVIEWS, "a review")
      const category = filter.category === undefined ? null : fold(filter.category.trim())
      const by = proposedBySql("t.author_type", "t.author_id", filter.proposedBy)
      return database
        .prepare(
          `${TRANSACTIONS} WHERE t.deleted_at IS NULL AND (? IS NULL OR t.financial_account_id = ?) ` +
            "AND (? IS NULL OR t.direction = ?) AND (? IS NULL OR t.status = ?) AND (? IS NULL OR t.review = ?) " +
            "AND (? IS NULL OR t.project_id = ? OR EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id " +
            "AND s.project_id = ?)) AND (? IS NULL OR EXISTS (SELECT 1 FROM transaction_splits s " +
            "WHERE s.transaction_id = t.id AND s.category_folded = ?)) " +
            `${filter.uncategorized ? "AND split < t.amount " : ""}AND ${by.sql} ` +
            "ORDER BY t.statement_date DESC, t.id DESC LIMIT ?",
        )
        .all(
          wallet,
          wallet,
          direction,
          direction,
          status,
          status,
          review,
          review,
          project,
          project,
          project,
          category,
          category,
          ...by.params,
          Math.min(Math.max(filter.limit ?? 100, 1), 500),
        )
        .map(transactionOf)
    },
    update: (reference, input) => {
      const row = rowOf(reference)
      const ref = `transaction:${row.id}`
      mayChange(row, input.by)
      const status =
        input.status === undefined
          ? (row.status as TransactionStatus)
          : oneOf(input.status, TRANSACTION_STATUSES, "a status")
      const bookedDate =
        input.status === undefined && input.bookedDate === undefined
          ? (row.booked_date as string | null)
          : bookingOf(status, input.bookedDate, String(row.statement_date))
      write(database, () => {
        const moved = { direction: String(row.direction), amount: Number(row.amount), currency: String(row.currency) }
        const payment =
          input.payment === undefined
            ? (row.payment_id as number | null)
            : paymentFor(input.payment, moved, Number(row.id))
        const counterparty =
          input.counterparty === undefined
            ? { type: row.counterparty_type as string | null, id: row.counterparty_id as number | null }
            : input.counterparty === null
              ? { type: null, id: null }
              : (partyThing(input.counterparty, "the counterparty") as { type: string; id: number })
        database
          .prepare(
            "UPDATE financial_transactions SET status = ?, booked_date = ?, payment_id = ?, counterparty_type = ?, " +
              "counterparty_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(status, bookedDate, payment, counterparty.type, counterparty.id, now(), Number(row.id))
      })
      return transactionOf(rowOf(ref))
    },
    addSplit: (reference, { by, ...split }) => {
      const row = rowOf(reference)
      mayChange(row, by)
      write(database, () => {
        const rows = splitRows([split], String(row.currency), Number(row.amount), Number(row.split))
        const last = Number(
          database
            .prepare("SELECT coalesce(max(position), 0) AS n FROM transaction_splits WHERE transaction_id = ?")
            .get(Number(row.id))?.n,
        )
        if (last >= MAX_SPLITS) refuse(`a transaction has at most ${MAX_SPLITS} splits`, "transaction.split")
        insertSplits(Number(row.id), rows, last + 1)
      })
      return transactionOf(rowOf(`transaction:${row.id}`))
    },
    removeSplit: (reference, { position, by }) => {
      const row = rowOf(reference)
      mayChange(row, by)
      const gone = database
        .prepare("DELETE FROM transaction_splits WHERE transaction_id = ? AND position = ?")
        .run(Number(row.id), position)
      if (gone.changes === 0)
        throw new CliError("not_found", `transaction:${row.id} has no split ${position}`, {
          reason: "transaction.no-split",
        })
      return transactionOf(rowOf(`transaction:${row.id}`))
    },
    categories: (filter = {}) => {
      const wallet = filter.wallet === undefined ? null : linkedId(filter.wallet, "wallet", "transaction.ref")
      const from = isoDate(filter.from, "the first day counted")
      const until = isoDate(filter.until, "the last day counted")
      const where =
        "t.review = 'confirmed' AND t.status = 'booked' AND t.deleted_at IS NULL AND (? IS NULL OR t.financial_account_id = ?) " +
        "AND (? IS NULL OR t.booked_date >= ?) AND (? IS NULL OR t.booked_date <= ?)"
      const params = [wallet, wallet, from, from, until, until]
      const split = database
        .prepare(
          "SELECT min(s.category) AS category, s.category_folded, t.currency, sum(s.amount) AS units FROM transaction_splits s " +
            `JOIN financial_transactions t ON t.id = s.transaction_id WHERE ${where} ` +
            "GROUP BY s.category_folded, t.currency ORDER BY s.category_folded, t.currency",
        )
        .all(...params)
      const rest = database
        .prepare(
          "SELECT t.currency, sum(t.amount - (SELECT coalesce(sum(amount), 0) FROM transaction_splits " +
            `WHERE transaction_id = t.id)) AS units FROM financial_transactions t WHERE ${where} GROUP BY t.currency`,
        )
        .all(...params)
      return [
        ...split.map((row) => ({
          category: String(row.category),
          ...moneyOf(Number(row.units), String(row.currency)),
        })),
        ...rest
          .filter((row) => Number(row.units) > 0)
          .map((row) => ({ category: null, ...moneyOf(Number(row.units), String(row.currency)) })),
      ]
    },
    confirm: (reference, by, reason) => decide(reference, by, reason, true),
    reject: (reference, by, reason) => decide(reference, by, reason, false),
  }
}

export const transactionsStoreOver = (context: StoreContext): TransactionsStore => {
  const operations = transactionOperationsOver(context)
  return {
    add: async (input) => operations.add(input),
    get: async (reference) => operations.get(reference),
    list: async (filter) => operations.list(filter),
    update: async (reference, input) => operations.update(reference, input),
    addSplit: async (reference, input) => operations.addSplit(reference, input),
    removeSplit: async (reference, input) => operations.removeSplit(reference, input),
    categories: async (filter) => operations.categories(filter),
    confirm: async (reference, by, reason) => operations.confirm(reference, by, reason),
    reject: async (reference, by, reason) => operations.reject(reference, by, reason),
  }
}
