import type { Contract, MessageStore } from "../../../store/index.js"
import type { ProposalKind } from "../types.js"
import { reviewedKind, reviewedRow } from "./shared.js"

/** An agent's or an import's contract with a value, by its own ref (`contract:12`); only the owner decides it. */
export const contractKind = (store: Pick<MessageStore, "contracts">): ProposalKind =>
  reviewedKind<Contract>({
    kind: "contract",
    prefix: "contract",
    list: (options) => store.contracts.list(options),
    get: (id) => store.contracts.get(id),
    row: (contract) => reviewedRow("contract", contract, contract.deal),
    decide: async (id, confirm, { by, reason }) =>
      (confirm ? await store.contracts.confirm(id, by, reason) : await store.contracts.reject(id, by, reason)).ref,
  })
