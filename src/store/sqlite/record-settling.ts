import { CliError } from "@wirecat/cli-base"
import { formatDecimal, minorUnits, scaleOf } from "../../domain/money.js"
import type { EnvelopeRecord } from "../../domain/records.js"
import type { financeOperationsOver, PaymentDetail } from "./finance.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { IMPORTER, refusal, type Share } from "./record-projection.js"
import { netPaidSql } from "./refunds.js"

const codeOf = (error: CliError): string => {
  const reason = (error.details as { reason?: unknown } | undefined)?.reason
  return typeof reason === "string" ? reason : "record.entity"
}

/** How an imported payment settles the invoices its record names. */
export const recordSettlingOver = (
  { database }: StoreContext,
  finance: ReturnType<typeof financeOperationsOver>,
  sharesOf: (recordId: number) => Share[],
) => {
  const sql = (text: string) => database.prepare(text)
  /**
   * What other payments leave open on an invoice. Proposed ones count too: the owner confirms them later, so payments
   * of one batch would otherwise each take the whole invoice.
   */
  const freeOn = (invoice: string, payment: string): number => {
    const [target, own] = [requiredThing(database, invoice), requiredThing(database, payment)]
    const row = sql(
      `SELECT i.total - ${netPaidSql("i.id", { counted: "pending", excluding: "?" })} AS free FROM invoices i WHERE i.id = ?`,
    ).get(own.id, target.id)
    return Number(row?.free ?? 0)
  }

  /** A payment settles each invoice it names by the amount the source gives, then the rest as far as both allow. */
  const settle = (made: PaymentDetail, shares: Share[]): string => {
    const units = (amount: string) => minorUnits(amount, made.currency)
    let left = units(made.unallocated)
    const given = shares.filter((one) => one.amount !== null)
    for (const { invoice, amount } of [...given, ...shares.filter((one) => one.amount === null)]) {
      const share = amount === null ? Math.min(left, freeOn(invoice, made.ref)) : units(amount)
      if (share <= 0) continue
      finance.allocate({
        payment: made.ref,
        invoice,
        amount: formatDecimal(share, scaleOf(made.currency)),
        by: IMPORTER,
      })
      left -= share
    }
    return made.ref
  }

  /** A payment the import proposed and the owner has not decided yet takes its record's settles relations again. */
  const resettle = (recordId: number, ref: string): boolean => {
    const payment = finance.payment(ref)
    if (payment.review !== "proposed" || payment.author.type !== "bot" || payment.author.name !== IMPORTER.bot)
      return false
    for (const { invoice } of payment.allocations) finance.unallocate({ payment: ref, invoice, by: IMPORTER })
    settle(finance.payment(ref), sharesOf(recordId))
    return true
  }

  /** The settles amounts a payment record gives, refused at the first one that is not money or goes past the payment. */
  const checkShares = (record: EnvelopeRecord) => {
    const relations = record.relations ?? []
    if (record.type !== "payment" || !relations.some((relation) => relation.amount !== undefined)) return
    const fields = record.fields ?? {}
    if (typeof fields.currency !== "string") return
    const currency = fields.currency
    let left: number
    try {
      left = minorUnits(fields.amount, currency)
    } catch {
      return
    }
    for (const [index, { amount }] of relations.entries()) {
      if (amount === undefined) continue
      const at = ["relations", index, "amount"]
      let units = 0
      try {
        units = minorUnits(amount, currency, "a settles amount")
      } catch (error) {
        if (!(error instanceof CliError)) throw error
        refusal(error.message, codeOf(error), at)
      }
      if (units <= 0) refusal("a settles amount is more than 0", "money.amount", at)
      left -= units
      if (left < 0)
        refusal(
          `the settles amounts add up to more than the payment's ${String(fields.amount)} ${currency}`,
          "record.over-payment",
          at,
        )
    }
  }

  return { settle, resettle, checkShares }
}
