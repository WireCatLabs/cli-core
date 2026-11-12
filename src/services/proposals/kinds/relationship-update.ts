import type { MessageStore, ProposedAction, RelationUpdate } from "../../../store/index.js"
import { proposerOfAction } from "../../../store/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { actionStatus, kept, projectOf, pushed, storedStatus } from "./shared.js"

interface Payload {
  relationship: string
  from: string
  to: string
  changes: RelationUpdate
}

const KIND = "relationship_update"

const summaryOf = ({ changes }: Payload): string =>
  Object.entries(changes)
    .map(([field, value]) => `${field} ${value ?? "cleared"}`)
    .join(", ")

const rowOf = (action: ProposedAction): ProposalRow => {
  const payload = action.payload as Payload
  return {
    id: action.id,
    kind: KIND,
    status: actionStatus(action.status),
    project: projectOf(payload.to, payload.from),
    subject: `relationship:${payload.relationship}`,
    object: payload.to,
    summary: summaryOf(payload),
    proposedBy: proposerOfAction(action),
    reason: action.reason,
    evidence: [],
    score: null,
    signals: null,
    parts: null,
    createdAt: action.createdAt,
  }
}

/** An agent's change to a relationship's role or purpose; the owner's applies at once and never waits here. */
export const relationshipUpdateKind = (store: Pick<MessageStore, "knowledge" | "proposedActions">): ProposalKind => ({
  kind: KIND,
  stored: [KIND],
  list: async (filter) => {
    const status = storedStatus(filter)
    const { items: stored } = await store.proposedActions.list({
      kinds: [KIND],
      ...(status === undefined ? {} : { status }),
      ...pushed(filter),
    })
    return kept(stored.map(rowOf), filter)
  },
  get: async (id) => rowOf(await store.proposedActions.get(id)),
  decide: async (id, { confirm, by, reason }): Promise<Decided> => {
    const { relation } = await store.knowledge.decideRelationUpdate(id, {
      confirm,
      by,
      ...(reason === undefined ? {} : { reason }),
    })
    return {
      id,
      kind: KIND,
      status: confirm ? "confirmed" : "rejected",
      made: relation ? [`relationship:${relation.id}`] : [],
    }
  },
})
