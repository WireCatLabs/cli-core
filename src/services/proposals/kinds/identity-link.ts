import type { MessageStore, ProposedAction } from "../../../store/index.js"
import { IDENTITY_LINK_KIND, type IdentityLinkPayload, proposerOfAction } from "../../../store/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { actionStatus, kept, pushed, storedStatus } from "./shared.js"

const rowOf = (action: ProposedAction): ProposalRow => {
  const payload = action.payload as IdentityLinkPayload
  const [from, to] = payload.persons
  return {
    id: action.id,
    kind: IDENTITY_LINK_KIND,
    status: actionStatus(action.status),
    project: null,
    subject: `person:${from}`,
    object: `person:${to}`,
    summary: `${payload.identity} may be the same person as ${payload.with ?? `person:${to}`} (${payload.signal})`,
    proposedBy: proposerOfAction(action),
    reason: action.reason,
    evidence: payload.evidence.slice(0, 5),
    score: payload.score,
    signals: null,
    parts: null,
    createdAt: action.createdAt,
  }
}

/** Two identities' people that may be one; only the owner says whether they are. */
export const identityLinkKind = (store: Pick<MessageStore, "people" | "proposedActions">): ProposalKind => ({
  kind: IDENTITY_LINK_KIND,
  stored: [IDENTITY_LINK_KIND],
  ownerOnly: true,
  list: async (filter) => {
    const status = storedStatus(filter)
    const stored = await store.proposedActions.list({
      kinds: [IDENTITY_LINK_KIND],
      ...(status === undefined ? {} : { status }),
      ...pushed(filter),
    })
    return kept(stored.map(rowOf), filter)
  },
  get: async (id) => rowOf(await store.proposedActions.get(id)),
  decide: async (id, { confirm, by, reason }): Promise<Decided> => {
    const decided = await store.people.decideLink(id, { confirm, by, ...(reason === undefined ? {} : { reason }) })
    const person = (decided.result as { person?: string } | null)?.person
    return {
      id,
      kind: IDENTITY_LINK_KIND,
      status: confirm ? "confirmed" : "rejected",
      made: person === undefined ? [] : [`person:${person}`],
    }
  },
})
