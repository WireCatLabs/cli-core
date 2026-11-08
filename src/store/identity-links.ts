import type { Decider } from "./decisions.js"
import type { Author } from "./sqlite/memories.js"
import type { IdentityRef } from "./types.js"

export const IDENTITY_LINK_KIND = "identity_link"

/**
 * Why two people may be one: an agent said so, they share a phone or an address with others, or a meeting guest typed
 * an address another person has.
 */
export const IDENTITY_LINK_SIGNALS = ["agent", "phone", "email", "guest-email"] as const

export type IdentityLinkSignal = (typeof IDENTITY_LINK_SIGNALS)[number]

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
}

/** What one pass of the people matcher did. */
export interface MatchScan {
  /** Every identity was read, not only those changed since the last pass. */
  full: boolean
  /** People joined without asking: same address, or a phone exactly two people have. */
  merged: { into: string; from: string; signal: "same-email" | "same-phone" }[]
  /** Proposals opened, or open ones met again. */
  proposed: { id: string; persons: [string, string]; signal: IdentityLinkSignal; opened: boolean }[]
  /** Pairs left apart, with why: the owner separated or rejected them, or too many people share the value. */
  skipped: { persons: string[]; signal: string; reason: string }[]
}
