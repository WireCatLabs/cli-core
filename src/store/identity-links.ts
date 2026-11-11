import type { Decider, Proposer } from "./decisions.js"
import type { Author } from "./sqlite/memories.js"
import type { IdentityRef } from "./types.js"

export const IDENTITY_LINK_KIND = "identity_link"

/**
 * Why two people may be one: an agent said so, they share a phone or an address with others, a meeting guest typed
 * an address another person has, they have one name and share a phone, an address, a chat or a company's domain, or
 * an account the owner connected carries another name than the owner's (`account`).
 */
export const IDENTITY_LINK_SIGNALS = ["agent", "phone", "email", "guest-email", "name", "account"] as const

export type IdentityLinkSignal = (typeof IDENTITY_LINK_SIGNALS)[number]

/** A mailbox more than one person reads: a role address such as `info@`, or a company's line (`sharedLine`). */
export type SharedMailbox = "role" | "line"

/** An `identity_link` proposal's payload. */
export interface IdentityLinkPayload {
  /** `provider:id` of the identity that would move. */
  identity: string
  /** `provider:id` of an identity of the person it would join; `null` for a person known by name only. */
  with: string | null
  /** The person `identity` is on and the one it would join, as uids when it was proposed. */
  persons: [string, string]
  /** Each person's identities when it was proposed, so a confirm after either changed is refused. */
  sides: [string, string]
  /** `person` joins the two people; `identity` moves only `identity`, leaving the rest of its person. */
  joins: "person" | "identity"
  signal: IdentityLinkSignal
  score: number | null
  /** Every person the signal points at, the two included, when it points at more than two. */
  candidates?: string[]
  evidence: string[]
  /** The address both people have is a shared mailbox; absent on proposals made before it was recorded. */
  shared?: SharedMailbox
  /** The shared mailbox's address, with `shared`. */
  mailbox?: string
}

export interface IdentityLinkInput {
  identity: IdentityRef
  with: IdentityRef
  signal: IdentityLinkSignal
  by: Author
  reason?: string
  score?: number
  evidence?: string[]
}

export interface IdentityLinkDecision {
  confirm: boolean
  /** `"owner"` only on a path that established the owner decides; an agent is refused whatever the policy says. */
  by: Decider
  reason?: string
  /**
   * With `confirm: false` on a shared-mailbox proposal: the address is this organization's, not one of the two people.
   * `organization` names one; otherwise the one holding the address or its company domain, or one of `name`, or a new
   * company named `name` or the domain. `all` closes every open proposal on the same mailbox in this one decision;
   * the decided proposal's result lists them all as `closed`. On a match that is not about a shared mailbox (one by
   * name), `mailbox` names which of the two people's addresses is the company's.
   */
  company?: { organization?: number; name?: string; all?: boolean; mailbox?: string }
}

/** One `identity_link`, naming the people as they are now, not as they were when it was proposed. */
export interface IdentityLinkRow {
  id: string
  status: "proposed" | "confirmed" | "rejected"
  /** `person:<uid>` of the person `identity` is on, then of the one it would join. */
  persons: [string, string]
  identity: string
  with: string | null
  joins: IdentityLinkPayload["joins"]
  signal: IdentityLinkSignal
  score: number | null
  /** The address the two people share is a role address (`role`) or a company's line (`line`), not one person's. */
  shared: SharedMailbox | null
  /** That shared address, which `decideLink` with `company` gives to an organization. */
  mailbox: string | null
  candidates: string[]
  reason: string | null
  evidence: string[]
  proposedBy: Proposer
  createdAt: string
}

export interface IdentityLinkFilter {
  /** Only the proposals naming this person, or anyone merged into them, as they are now. */
  person?: string
  /** `proposed` unless named. */
  status?: IdentityLinkRow["status"] | "all"
  /** `score`: highest score first, proposals without one last, each newest first; newest first otherwise. */
  order?: "newest" | "score"
  limit: number
  offset: number
}

/** What one pass of the people matcher did. */
export interface MatchScan {
  /** Every identity was read, not only those changed since the last pass. */
  full: boolean
  /** People joined without asking: the same personal address, or a phone exactly two people have. */
  merged: { into: string; from: string; signal: "same-email" | "same-phone" }[]
  /** Proposals opened, or open ones met again. */
  proposed: { id: string; persons: [string, string]; signal: IdentityLinkSignal; opened: boolean }[]
  /** Pairs left apart, with why: the owner separated or rejected them, or too many people share the value. */
  skipped: { persons: string[]; signal: string; reason: string }[]
}
