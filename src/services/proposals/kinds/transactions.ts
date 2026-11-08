import type { MessageStore, MoneyTransaction } from "../../../store/index.js"
import type { ProposalKind } from "../types.js"
import { reviewedKind, reviewedRow } from "./shared.js"

/** An agent's or an import's bank transaction, by its own ref (`transaction:12`); only the owner decides it. */
export const transactionKind = (store: Pick<MessageStore, "transactions">): ProposalKind =>
  reviewedKind<MoneyTransaction>({
    kind: "transaction",
    prefix: "transaction",
    list: (options) => store.transactions.list(options),
    get: (id) => store.transactions.get(id),
    row: (transaction) => reviewedRow("transaction", transaction, transaction.counterparty?.ref ?? transaction.wallet),
    decide: async (id, confirm, { by, reason }) =>
      (confirm ? await store.transactions.confirm(id, by, reason) : await store.transactions.reject(id, by, reason))
        .ref,
  })
