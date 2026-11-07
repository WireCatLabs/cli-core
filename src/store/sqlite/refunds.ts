import { CliError } from "@wirecat/cli-base"
import { moneyLabel } from "../../domain/money.js"
import type { StoreContext } from "./open.js"

type Row = Record<string, unknown>

const COUNTED = {
  confirmed: "np.review = 'confirmed' AND np.deleted_at IS NULL",
  live: "np.review <> 'rejected' AND np.deleted_at IS NULL",
} as const

/**
 * What is paid on `invoice`, net: ordinary payments' allocations minus their refunds'. Every sum of paid money reads
 * this one fragment, so the code and the triggers agree. `including` also counts one payment whatever its review;
 * `excluding` leaves one out. Each is an SQL expression, such as `?` or a column of the outer query.
 */
export const netPaidSql = (
  invoice: string,
  {
    counted = "confirmed",
    including,
    excluding,
  }: { counted?: keyof typeof COUNTED; including?: string; excluding?: string } = {},
): string => {
  const which = including === undefined ? COUNTED[counted] : `((${COUNTED[counted]}) OR na.payment_id = ${including})`
  return (
    "(SELECT coalesce(sum(CASE WHEN np.refund_of IS NULL THEN na.amount ELSE -na.amount END), 0) " +
    "FROM payment_allocations na JOIN payments np ON np.id = na.payment_id " +
    `WHERE na.invoice_id = ${invoice} AND ${which}${excluding === undefined ? "" : ` AND na.payment_id <> ${excluding}`})`
  )
}

const refuse = (message: string, reason: string): never => {
  throw new CliError("validation_error", message, { reason })
}

/** A refund is a payment the other way with `refund_of`; these rules keep net paid at 0 or more for every payment. */
export const refundRulesOver = (context: StoreContext) => {
  const { database } = context
  const one = (sql: string, ...params: (string | number | null)[]) =>
    Number(database.prepare(sql).get(...params)?.n ?? 0)

  const confirmedRefunds = (original: number, without?: number) =>
    one(
      "SELECT coalesce(sum(amount), 0) AS n FROM payments WHERE refund_of = ? AND review = 'confirmed' " +
        "AND deleted_at IS NULL AND id IS NOT ?",
      original,
      without ?? null,
    )

  const withinOriginal = (original: Row, units: number, without?: number) => {
    const done = confirmedRefunds(Number(original.id), without)
    const currency = String(original.currency)
    if (done + units > Number(original.amount))
      refuse(
        `payment:${original.id} is ${moneyLabel(Number(original.amount), currency)} and ` +
          `${moneyLabel(done, currency)} of it is already refunded; ${moneyLabel(units, currency)} more is too much`,
        "finance.over-refund",
      )
  }

  /** The payment a new refund names: live, not a refund itself, the other way and in the same currency. */
  const originalFor = (id: number, refund: { direction: string; currency: string; amount: number }): Row => {
    const original = database.prepare("SELECT * FROM payments WHERE id = ?").get(id) as Row
    const ref = `payment:${id}`
    if (original.refund_of != null) refuse(`${ref} is itself a refund; refund the payment it refunds`, "finance.refund")
    if (original.review === "rejected" || original.deleted_at != null)
      refuse(
        `${ref} is ${original.review === "rejected" ? "rejected" : "deleted"}; there is nothing to refund`,
        "finance.refund",
      )
    if (original.direction === refund.direction)
      refuse(`a refund of ${ref} goes the other way: ${original.direction === "in" ? "out" : "in"}`, "finance.refund")
    if (original.currency !== refund.currency)
      refuse(`a refund of ${ref} is in its currency, ${String(original.currency)}`, "finance.refund")
    withinOriginal(original, refund.amount)
    return original
  }

  /** A refund's share of an invoice: only one its payment is allocated to, and never more than that payment gave it. */
  const refundShare = (refund: Row, invoiceId: number, units: number) => {
    const original = Number(refund.refund_of)
    const given = database
      .prepare("SELECT amount FROM payment_allocations WHERE payment_id = ? AND invoice_id = ?")
      .get(original, invoiceId)
    if (!given)
      refuse(
        `payment:${refund.id} refunds payment:${original}, which is not allocated to invoice:${invoiceId}; ` +
          "a refund goes back only where its payment went",
        "finance.refund",
      )
    const back = one(
      "SELECT coalesce(sum(a.amount), 0) AS n FROM payment_allocations a JOIN payments r ON r.id = a.payment_id " +
        "WHERE a.invoice_id = ? AND r.refund_of = ? AND ((r.review = 'confirmed' AND r.deleted_at IS NULL) OR r.id = ?)",
      invoiceId,
      original,
      Number(refund.id),
    )
    const currency = String(refund.currency)
    if (back + units > Number(given?.amount))
      refuse(
        `payment:${original} gave invoice:${invoiceId} ${moneyLabel(Number(given?.amount), currency)} and ` +
          `${moneyLabel(back, currency)} of it is already refunded; ${moneyLabel(units, currency)} more is too much`,
        "finance.over-refund",
      )
  }

  /** A refund is confirmed after its payment, and still within it and within each share it takes back. */
  const confirmable = (refund: Row) => {
    const original = database.prepare("SELECT * FROM payments WHERE id = ?").get(Number(refund.refund_of)) as Row
    if (original.review !== "confirmed" || original.deleted_at != null)
      refuse(
        `payment:${refund.id} refunds payment:${original.id}, which is ${String(original.review)}; ` +
          "confirm the payment first",
        "finance.refund",
      )
    withinOriginal(original, Number(refund.amount), Number(refund.id))
    for (const share of database
      .prepare("SELECT invoice_id, amount FROM payment_allocations WHERE payment_id = ?")
      .all(Number(refund.id)))
      refundShare(refund, Number(share.invoice_id), 0)
  }

  /** A payment with a live refund stays: rejecting it would leave the refund taking back money never paid. */
  const keepsRefunded = (payment: Row) => {
    const refund = database
      .prepare("SELECT id FROM payments WHERE refund_of = ? AND review <> 'rejected' AND deleted_at IS NULL LIMIT 1")
      .get(Number(payment.id))
    if (refund)
      refuse(`payment:${refund.id} refunds payment:${payment.id}; reject the refund first`, "finance.refunded")
  }

  /** A payment's share of an invoice stays while a refund of it takes part of that share back. */
  const keepsShare = (paymentId: number, invoiceId: number) => {
    const refund = database
      .prepare(
        "SELECT a.payment_id AS id FROM payment_allocations a JOIN payments r ON r.id = a.payment_id " +
          "WHERE r.refund_of = ? AND a.invoice_id = ? LIMIT 1",
      )
      .get(paymentId, invoiceId)
    if (refund)
      refuse(
        `payment:${refund.id} refunds part of what payment:${paymentId} gave invoice:${invoiceId}; take that back first`,
        "finance.refunded",
      )
  }

  return { originalFor, refundShare, confirmable, keepsRefunded, keepsShare }
}
