import type { FinancePayment, Invoice, MessageStore } from "../../../store/index.js"
import type { ProposalKind } from "../types.js"
import { reviewedKind, reviewedRow } from "./shared.js"

/**
 * An agent's or an import's invoice or payment. One kind per entity, because the registry routes an id by its prefix
 * and the id is the entry's own ref (`payment:12`), as a fact's is. Only the owner decides money.
 */
export const invoiceKind = (store: Pick<MessageStore, "finance">): ProposalKind =>
  reviewedKind<Invoice>({
    kind: "invoice",
    prefix: "invoice",
    list: (options) => store.finance.invoices(options),
    get: (id) => store.finance.invoice(id),
    row: (invoice) => reviewedRow("invoice", invoice, invoice.counterparty.ref),
    decide: async (id, confirm, { by, reason }) =>
      (confirm ? await store.finance.confirm(id, by, reason) : await store.finance.reject(id, by, reason)).ref,
  })

export const paymentKind = (store: Pick<MessageStore, "finance">): ProposalKind =>
  reviewedKind<FinancePayment>({
    kind: "payment",
    prefix: "payment",
    list: (options) => store.finance.payments(options),
    get: (id) => store.finance.payment(id),
    row: (payment) =>
      reviewedRow("payment", payment, (payment.direction === "in" ? payment.payer : payment.payee)?.ref ?? null),
    decide: async (id, confirm, { by, reason }) =>
      (confirm ? await store.finance.confirm(id, by, reason) : await store.finance.reject(id, by, reason)).ref,
  })
