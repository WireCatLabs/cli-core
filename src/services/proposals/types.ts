import type { Decider, Proposer, Refusal } from "../../store/decisions.js"

export interface ProposalRow {
  /** `17070` for a stored proposal; `fact:512`, `memory:88`, `link:17` and `key:9` for the kinds kept elsewhere. */
  id: string
  kind: string
  status: "proposed" | "confirmed" | "rejected"
  project: string | null
  /** The reference it is about. */
  subject: string
  /** The reference it links to, when it links. */
  object: string | null
  /** A fact's statement or a finding count; never message text. */
  summary: string | null
  proposedBy: Proposer
  reason: string | null
  /** At most 5 references. */
  evidence: string[]
  score: number | null
  signals: { scorer: string; weight: number; why: string }[] | null
  parts: { id: string; kind: string; summary: string; outcome: "accepted" | "rejected" | null }[] | null
  createdAt: string
}

export interface ProposalFilter {
  project?: string
  kinds?: string[]
  by?: "agent" | "rule" | { bot: string }
  status?: ProposalRow["status"] | "all"
  limit: number
  offset: number
}

export interface Decision {
  confirm: boolean
  by: Decider
  reason?: string
  /** The findings of a batch to accept; the rest are rejected. */
  parts?: string[]
}

export interface Decided {
  id: string
  kind: string
  status: "confirmed" | "rejected"
  /** References the decision made: `relationship:2203`, `fact:530`, `task:…`. */
  made: string[]
}

/**
 * One kind of proposal. `prefix` names its own id space (`fact` for `fact:512`); a kind stored in `proposed_actions`
 * names the stored kinds it owns in `stored` and has bare number ids. A new kind registers itself; nothing else changes.
 */
export interface ProposalKind {
  readonly kind: string
  readonly prefix?: string
  readonly stored?: readonly string[]
  /** Bounded: at most `offset + limit` rows, newest first. */
  list(filter: ProposalFilter): Promise<ProposalRow[]>
  get(id: string): Promise<ProposalRow>
  /** Called only after `mayDecide` allowed it. */
  decide(id: string, decision: Decision): Promise<Decided>
}

export interface ProposalRegistry {
  register(kind: ProposalKind): void
  list(filter: ProposalFilter): Promise<{ items: ProposalRow[]; hasMore: boolean }>
  get(id: string): Promise<ProposalRow>
  /** Each id on its own: one refusal never undoes the others. */
  decide(ids: string[], decision: Decision): Promise<{ decided: Decided[]; refused: Refusal[] }>
}
