import type { MessageStore, ProposedAction } from "../../../store/index.js"
import { proposerOfAction } from "../../../store/index.js"
import { SOURCE_REVIEW_KIND, type SourceReviewPayload } from "../../../store/source-review.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { actionStatus, kept, pushed, storedStatus } from "./shared.js"

const rowOf = (action: ProposedAction): ProposalRow => {
  const payload = action.payload as SourceReviewPayload
  const sources = payload.sources.flatMap((source) => source.ref ?? [])
  const contradicting = payload.challenges.flatMap((challenge) => challenge.evidence)
  const replacement = payload.sources.find((source) => source.replacement !== undefined)?.replacement ?? null
  return {
    id: action.id,
    kind: SOURCE_REVIEW_KIND,
    status: actionStatus(action.status),
    project: null,
    subject: action.target ?? payload.target,
    object: replacement,
    summary: `${payload.cause}: ${payload.sources.length} source(s), ${payload.challenges.length} challenge(s)`,
    proposedBy: proposerOfAction(action),
    reason: payload.challenges.at(-1)?.reason ?? action.reason,
    evidence: [...new Set([...sources, ...contradicting])].slice(0, 5),
    score: null,
    signals: null,
    parts: null,
    createdAt: payload.raisedAt,
  }
}

/** A memory or fact whose sources changed, went or were contradicted; only the owner says whether it still holds. */
export const sourceReviewKind = (store: Pick<MessageStore, "knowledge" | "proposedActions">): ProposalKind => ({
  kind: SOURCE_REVIEW_KIND,
  stored: [SOURCE_REVIEW_KIND],
  ownerOnly: true,
  list: async (filter) => {
    const status = storedStatus(filter)
    const stored = await store.proposedActions.list({
      kinds: [SOURCE_REVIEW_KIND],
      ...(status === undefined ? {} : { status }),
      ...pushed(filter),
    })
    return kept(stored.map(rowOf), filter)
  },
  get: async (id) => rowOf(await store.proposedActions.get(id)),
  decide: async (id, { confirm, by, reason }): Promise<Decided> => {
    await store.knowledge.decideSourceReview(id, { confirm, by, ...(reason === undefined ? {} : { reason }) })
    return { id, kind: SOURCE_REVIEW_KIND, status: confirm ? "confirmed" : "rejected", made: [] }
  },
})
