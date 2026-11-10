import type { MessageStore, ProposedAction } from "../../../store/index.js"
import { IDENTITY_SPLIT_KIND, type IdentitySplitPayload, proposerOfAction } from "../../../store/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { actionStatus, kept, pushed, storedStatus } from "./shared.js"

const summaryOf = (payload: IdentitySplitPayload): string =>
  payload.split === "unmerge"
    ? `undo ${payload.merge}: ${payload.identities.join(", ")} go back to their own person`
    : `${payload.identities.join(", ")} may not be person:${payload.person}: they would move to a person of their own`

const rowOf = (action: ProposedAction): ProposalRow => {
  const payload = action.payload as IdentitySplitPayload
  return {
    id: action.id,
    kind: IDENTITY_SPLIT_KIND,
    status: actionStatus(action.status),
    project: null,
    subject: `person:${payload.person}`,
    object: null,
    summary: summaryOf(payload),
    proposedBy: proposerOfAction(action),
    reason: action.reason,
    evidence: payload.evidence.slice(0, 5),
    score: null,
    signals: null,
    parts: null,
    createdAt: action.createdAt,
  }
}

/** Identities that may not belong to their person; only the owner takes them off. */
export const identitySplitKind = (store: Pick<MessageStore, "people" | "proposedActions">): ProposalKind => ({
  kind: IDENTITY_SPLIT_KIND,
  stored: [IDENTITY_SPLIT_KIND],
  ownerOnly: true,
  list: async (filter) => {
    const status = storedStatus(filter)
    const stored = await store.proposedActions.list({
      kinds: [IDENTITY_SPLIT_KIND],
      ...(status === undefined ? {} : { status }),
      ...pushed(filter),
    })
    return kept(stored.map(rowOf), filter)
  },
  get: async (id) => rowOf(await store.proposedActions.get(id)),
  decide: async (id, { confirm, by, reason }): Promise<Decided> => {
    const decided = await store.people.decideSplit(id, { confirm, by, ...(reason === undefined ? {} : { reason }) })
    const person = (decided.result as { person?: string } | null)?.person
    return {
      id,
      kind: IDENTITY_SPLIT_KIND,
      status: confirm ? "confirmed" : "rejected",
      made: person === undefined ? [] : [`person:${person}`],
    }
  },
})
