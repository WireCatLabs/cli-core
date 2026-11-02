import { CliError } from "@wirecat/cli-base"
import { formatDecimal, minorUnits, parseDecimal, scaleOf } from "../../domain/money.js"
import { type Payment, paymentTitle } from "../../meetings/index.js"
import type { Decider } from "../decisions.js"
import { financeOperationsOver } from "./finance.js"
import type { Author } from "./memories.js"
import type { StoreContext } from "./open.js"

/** A payment as an agent's finding or a retired payment fact holds it. */
export interface PaymentEntry {
  payment: Payment
  statement?: string
  project?: string
  evidence: string[]
  /** The `invoice:` a paid entry settles or a cancelled one voids. */
  supersedes?: string
}

/** What becomes of the proposal: confirmed or rejected by the decider, or left proposed. */
export type PaymentOutcome = { confirm: boolean; by: Decider } | "proposed"

const refuse = (message: string, reason: string): never => {
  throw new CliError("validation_error", message, { reason })
}

/** The finding's two-decimal amount in the currency's own scale: "1200.00" JPY is "1200", "1200.50" JPY is refused. */
export const entryAmount = (payment: Payment): string => {
  const scale = scaleOf(payment.currency)
  const cents = parseDecimal(payment.amount, 2)
  if (cents === undefined) return refuse(`${payment.amount} is not an amount`, "money.amount")
  const shift = 10n ** BigInt(Math.abs(scale - 2))
  if (scale >= 2) return formatDecimal(cents * shift, scale)
  if (cents % shift !== 0n)
    return refuse(`${payment.currency} has ${scale} decimals; ${payment.amount} does not fit`, "money.amount")
  return formatDecimal(cents / shift, scale)
}

const party = (payment: Payment) =>
  /^(person|organization):/.test(payment.counterparty ?? "") ? payment.counterparty : null

/**
 * Money from a payment finding goes to `store.finance`, never into a fact: a paid one is a payment, allocated to the
 * invoice it supersedes as far as that is open; an expected one is an invoice of one line; a cancelled one voids its
 * invoice, which only the owner does. The author proposes; `outcome` is the owner's decision on it.
 */
export const paymentEntriesOver = (context: StoreContext) => {
  const finance = financeOperationsOver(context)
  const today = () => new Date(context.now()).toISOString().slice(0, 10)

  const decided = (ref: string, outcome: PaymentOutcome) => {
    if (outcome === "proposed") return ref
    return (outcome.confirm ? finance.confirm(ref, outcome.by) : finance.reject(ref, outcome.by)).ref
  }

  /** As much of the payment as the invoice still has open; nothing when it is already covered. */
  const settled = (reference: string, amount: string, currency: string) => {
    const invoice = finance.invoice(reference)
    const units = Math.min(minorUnits(amount, currency), minorUnits(invoice.open, invoice.currency))
    return units > 0 ? [{ invoice: invoice.ref, amount: formatDecimal(units, scaleOf(currency)) }] : []
  }

  return (entry: PaymentEntry, by: Author, outcome: PaymentOutcome): string => {
    const { payment } = entry
    const amount = entryAmount(payment)
    const project = entry.project ?? (payment.counterparty?.startsWith("project:") ? payment.counterparty : undefined)
    const written = {
      by,
      ...(project === undefined ? {} : { project }),
      ...(by === "owner" ? {} : { source: "agent", reason: entry.statement ?? paymentTitle(entry) }),
      evidence: entry.evidence,
    }
    const counterparty = party(payment)
    if (payment.state === "cancelled") {
      if (entry.supersedes === undefined)
        return refuse("a cancelled payment names the invoice it cancels", "finance.ref")
      if (outcome === "proposed" || !outcome.confirm) return entry.supersedes
      if (outcome.by !== "owner")
        throw new CliError("permission_error", "only the owner voids an invoice", { reason: "finance.owner-only" })
      return finance.voidInvoice(entry.supersedes, "owner").ref
    }
    if (payment.state === "expected") {
      if (counterparty === null)
        return refuse("an expected payment is an invoice, which names a person: or organization:", "finance.party")
      const invoice = finance.addInvoice({
        ...written,
        direction: payment.direction === "to_us" ? "receivable" : "payable",
        counterparty,
        currency: payment.currency,
        ...(payment.due_at === null ? {} : { dueDate: payment.due_at }),
        lines: [{ description: (payment.item ?? entry.statement ?? paymentTitle(entry)).slice(0, 500), amount }],
      })
      return decided(invoice.ref, outcome)
    }
    const settles = entry.supersedes === undefined ? [] : settled(entry.supersedes, amount, payment.currency)
    const made = finance.addPayment({
      ...written,
      direction: payment.direction === "to_us" ? "in" : "out",
      ...(counterparty === null
        ? {}
        : payment.direction === "to_us"
          ? { payer: counterparty }
          : { payee: counterparty }),
      amount,
      currency: payment.currency,
      date: payment.paid_at ?? payment.due_at ?? today(),
      ...(payment.item === null ? {} : { reference: payment.item }),
      allocations: settles,
    })
    return decided(made.ref, outcome)
  }
}
