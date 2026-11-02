import type { Fact, MessageStore } from "../../../store/index.js"
import type { ProposalKind, ProposalRow } from "../types.js"
import { kept, proposerOfAuthor, reading } from "./shared.js"

const STATUS: Record<Fact["status"], ProposalRow["status"]> = {
  proposed: "proposed",
  accepted: "confirmed",
  superseded: "confirmed",
  reversed: "confirmed",
  rejected: "rejected",
}

const rowOf = (fact: Fact): ProposalRow => ({
  id: fact.ref,
  kind: "fact",
  status: STATUS[fact.status],
  project: fact.project,
  subject: fact.subject ?? fact.ref,
  object: null,
  summary: fact.statement,
  proposedBy: proposerOfAuthor(fact.author),
  reason: null,
  evidence: fact.evidence.slice(0, 5),
  score: null,
  signals: null,
  parts: null,
  createdAt: fact.createdAt,
})

/** Facts keep their own table and lifecycle; an agent's waits as `proposed`. */
export const factKind = (store: Pick<MessageStore, "facts">): ProposalKind => ({
  kind: "fact",
  prefix: "fact",
  list: async (filter) => {
    const status = filter.status ?? "proposed"
    const facts = await store.facts.list({
      ...(filter.project === undefined ? {} : { project: filter.project }),
      ...(status === "proposed" || status === "rejected" ? { status } : {}),
      limit: reading(filter),
    })
    return kept(facts.map(rowOf), filter)
  },
  get: async (id) => rowOf(await store.facts.get(id)),
  decide: async (id, { confirm, by }) => {
    const fact = confirm ? await store.facts.accept(id, by) : await store.facts.reject(id, by)
    return { id, kind: "fact", status: confirm ? "confirmed" : "rejected", made: confirm ? [fact.ref] : [] }
  },
})
