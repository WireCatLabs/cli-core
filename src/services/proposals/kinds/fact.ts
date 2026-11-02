import type { Fact, MessageStore } from "../../../store/index.js"
import type { ProposalKind, ProposalRow } from "../types.js"
import { kept, proposerOfAuthor, pushed } from "./shared.js"

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
      ...pushed(filter),
      ...(status === "all" ? {} : { status: status === "confirmed" ? ("accepted" as const) : status }),
      order: "created",
    })
    return kept(facts.map(rowOf), filter)
  },
  get: async (id) => rowOf(await store.facts.get(id)),
  decide: async (id, { confirm, by, reason }) => {
    const fact = confirm ? await store.facts.accept(id, by, reason) : await store.facts.reject(id, by, reason)
    return { id, kind: "fact", status: confirm ? "confirmed" : "rejected", made: confirm ? [fact.ref] : [] }
  },
})
