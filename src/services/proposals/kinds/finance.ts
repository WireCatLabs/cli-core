import type { FinancePayment, Invoice, MessageStore } from "../../../store/index.js"
import type { ProposalKind, ProposalRow } from "../types.js"
import { kept, proposerOfAuthor, pushed } from "./shared.js"

const rowOf = (kind: "invoice" | "payment", entry: Invoice | FinancePayment): ProposalRow => ({
  id: entry.ref,
  kind,
  status: entry.review,
  project: entry.project,
  subject: entry.ref,
  object:
    "counterparty" in entry
      ? entry.counterparty.ref
      : ((entry.direction === "in" ? entry.payer : entry.payee)?.ref ?? null),
  summary: entry.title,
  proposedBy: proposerOfAuthor(entry.author),
  reason: entry.reason,
  evidence: [],
  score: null,
  signals: null,
  parts: null,
  createdAt: entry.createdAt,
})

/**
 * An agent's or an import's invoice or payment. One kind per entity, because the registry routes an id by its prefix
 * and the id is the entry's own ref (`payment:12`), as a fact's is. Only the owner decides money.
 */
const financeKind = (store: Pick<MessageStore, "finance">, kind: "invoice" | "payment"): ProposalKind => ({
  kind,
  prefix: kind,
  list: async (filter) => {
    const status = filter.status ?? "proposed"
    const options = { ...pushed(filter), ...(status === "all" ? {} : { review: status }) }
    const entries = kind === "invoice" ? await store.finance.invoices(options) : await store.finance.payments(options)
    return kept(
      entries.map((entry) => rowOf(kind, entry)),
      filter,
    )
  },
  get: async (id) =>
    rowOf(kind, kind === "invoice" ? await store.finance.invoice(id) : await store.finance.payment(id)),
  decide: async (id, { confirm, by, reason }) => {
    const entry = confirm ? await store.finance.confirm(id, by, reason) : await store.finance.reject(id, by, reason)
    return { id, kind, status: confirm ? "confirmed" : "rejected", made: confirm ? [entry.ref] : [] }
  },
})

export const invoiceKind = (store: Pick<MessageStore, "finance">): ProposalKind => financeKind(store, "invoice")
export const paymentKind = (store: Pick<MessageStore, "finance">): ProposalKind => financeKind(store, "payment")
