import type { Deal, MessageStore } from "../../../store/index.js"
import type { ProposalKind, ProposalRow } from "../types.js"
import { kept, proposerOfAuthor, pushed } from "./shared.js"

const rowOf = (deal: Deal): ProposalRow => ({
  id: deal.ref,
  kind: "deal",
  status: deal.review,
  project: deal.project,
  subject: deal.ref,
  object: deal.organization?.ref ?? null,
  summary: `Deal ${deal.summary}`,
  proposedBy: proposerOfAuthor(deal.author),
  reason: deal.reason,
  evidence: [],
  score: null,
  signals: null,
  parts: null,
  createdAt: deal.createdAt,
})

/** An agent's deal, by its own ref (`deal:12`) as orders are; only the owner decides it. */
export const dealKind = (store: Pick<MessageStore, "deals">): ProposalKind => ({
  kind: "deal",
  prefix: "deal",
  list: async (filter) => {
    const status = filter.status ?? "proposed"
    const deals = await store.deals.list({ ...pushed(filter), ...(status === "all" ? {} : { review: status }) })
    return kept(deals.map(rowOf), filter)
  },
  get: async (id) => rowOf(await store.deals.get(id)),
  decide: async (id, { confirm, by, reason }) => {
    const deal = confirm ? await store.deals.confirm(id, by, reason) : await store.deals.reject(id, by, reason)
    return { id, kind: "deal", status: confirm ? "confirmed" : "rejected", made: confirm ? [deal.ref] : [] }
  },
})
