import type { Decider, Proposer } from "./decisions.js"
import type { Author } from "./sqlite/memories.js"
import type { IdentityRef } from "./types.js"

/**
 * A stored kind of its own, not an `identity_link`: every reader of those takes a row for two people who may be one,
 * and would settle a split of one person away as moot.
 */
export const IDENTITY_SPLIT_KIND = "identity_split"

/** `unlink` moves the identities to one new person; `unmerge` gives a merge's identities back to their person. */
export type IdentitySplitMove = "unlink" | "unmerge"

/** An `identity_split` proposal's payload. */
export interface IdentitySplitPayload {
  split: IdentitySplitMove
  /** The person the identities would leave, as a uid when it was proposed. */
  person: string
  /** `provider:id` of each identity that would leave. */
  identities: string[]
  /** `merge:<to>-<from>` for an unmerge, `null` for an unlink. */
  merge: string | null
  /** The person's identities when it was proposed, so a confirm after the person changed is refused. */
  side: string
  evidence: string[]
}

/** Either the identities that leave, all of one person, or the merge to undo. */
export type IdentitySplitInput = ({ identities: IdentityRef[] } | { merge: string }) & {
  by: Author
  reason: string
  evidence?: string[]
}

export interface IdentitySplitDecision {
  confirm: boolean
  /** `"owner"` only on a path that established the owner decides; anyone else is refused. */
  by: Decider
  reason?: string
}

/** One `identity_split`, naming the person as they are now. */
export interface IdentitySplitRow {
  id: string
  /** `dropped`: an older build approved it as a plain action, and nothing was split. */
  status: "proposed" | "confirmed" | "rejected" | "dropped"
  split: IdentitySplitMove
  /** `person:<uid>` the identities are on now. */
  person: string
  identities: string[]
  merge: string | null
  reason: string | null
  evidence: string[]
  proposedBy: Proposer
  createdAt: string
}

export interface IdentitySplitFilter {
  /** `proposed` unless named. */
  status?: IdentitySplitRow["status"] | "all"
  limit: number
  offset: number
}
