import type { Memory, MessageStore } from "../../../store/index.js"
import type { ProposalKind, ProposalRow } from "../types.js"
import { kept, proposerOfAuthor, reading } from "./shared.js"

/** A stale memory is the one a person turned down; a superseded one held until another replaced it. */
const STATUS: Record<Memory["status"], ProposalRow["status"]> = {
  proposed: "proposed",
  confirmed: "confirmed",
  superseded: "confirmed",
  stale: "rejected",
}

const rowOf = (memory: Memory): ProposalRow => ({
  id: memory.ref,
  kind: "memory",
  status: STATUS[memory.status],
  project: memory.project,
  subject: memory.subject ?? memory.ref,
  object: null,
  summary: null,
  proposedBy: proposerOfAuthor(memory.author),
  reason: null,
  evidence: memory.evidence.slice(0, 5),
  score: null,
  signals: null,
  parts: null,
  createdAt: memory.createdAt,
})

/** Memories keep their own table; rejecting one marks it stale. */
export const memoryKind = (store: Pick<MessageStore, "memories">): ProposalKind => ({
  kind: "memory",
  prefix: "memory",
  list: async (filter) => {
    const status = filter.status ?? "proposed"
    const memories = await store.memories.list({
      ...(filter.project === undefined ? {} : { project: filter.project }),
      ...(status === "proposed" || status === "confirmed" ? { status } : {}),
      limit: reading(filter),
    })
    return kept(memories.map(rowOf), filter)
  },
  get: async (id) => rowOf(await store.memories.get(id)),
  decide: async (id, { confirm, by }) => {
    const memory = confirm ? await store.memories.confirm(id, by) : await store.memories.markStale(id)
    return { id, kind: "memory", status: confirm ? "confirmed" : "rejected", made: confirm ? [memory.ref] : [] }
  },
})
