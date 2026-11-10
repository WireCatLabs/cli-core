import type { MessageStore, ProposedAction } from "../../../store/index.js"
import { IDENTITY_SPLIT_KIND, type IdentitySplitPayload, proposerOfAction } from "../../../store/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { actionStatus, kept, pushed, storedStatus } from "./shared.js"

const summaryOf = (payload: IdentitySplitPayload, person: string): string =>
  payload.split === "unmerge"
    ? `undo ${payload.merge}: ${payload.identities.join(", ")} go back to their own person`
    : `${payload.identities.join(", ")} may not be ${person}: they would move to a person of their own`

/** An older build approved it as a plain action and split nothing: it shows as turned down, not as done. */
const dropped = (action: ProposedAction): boolean =>
  action.status !== "proposed" &&
  action.status !== "rejected" &&
  typeof (action.result as { person?: unknown } | null)?.person !== "string"

const rowOf =
  (store: Pick<MessageStore, "people">) =>
  async (action: ProposedAction): Promise<ProposalRow> => {
    const payload = action.payload as IdentitySplitPayload
    const [first] = payload.identities
    const now =
      first === undefined
        ? undefined
        : await store.people.personOf({
            provider: first.slice(0, first.indexOf(":")),
            id: first.slice(first.indexOf(":") + 1),
          })
    const person = `person:${now?.uid ?? payload.person}`
    const summary = summaryOf(payload, person)
    return {
      id: action.id,
      kind: IDENTITY_SPLIT_KIND,
      status: dropped(action) ? "rejected" : actionStatus(action.status),
      project: null,
      subject: person,
      object: null,
      summary: dropped(action)
        ? `not carried out: an older version approved it without splitting; ${summary}`
        : summary,
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
    return kept(await Promise.all(stored.map(rowOf(store))), filter)
  },
  get: async (id) => rowOf(store)(await store.proposedActions.get(id)),
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
