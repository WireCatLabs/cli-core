import type { Actor } from "../sqlite/actors.js"
import type { Author } from "../sqlite/memories.js"
import type { AccountKey } from "../store.js"

/**
 * Something an agent wants done outside the store, waiting for a person. The store only keeps the
 * decision: a messenger adapter executes an approved action and reports back with `executed` or `failed`.
 * `payload` may hold a reply's text — the one place outgoing text waits — so it is shown to the approver
 * and never copied into the agent log.
 */
export interface ProposedAction {
  id: string
  kind: string
  account: AccountKey | null
  target: string | null
  payload: unknown
  reason: string | null
  status: (typeof PROPOSAL_STATUSES)[number]
  /** `name` is a bot's handle; `null` for a person. */
  proposedBy: { type: Actor["type"]; id: string; name: string | null }
  decidedBy: { type: Actor["type"]; id: string } | null
  decidedAt: string | null
  executedAt: string | null
  result: unknown
  error: string | null
  verdict: (typeof PROPOSAL_VERDICTS)[number] | null
  createdAt: string
}

export interface ProposalInput {
  kind: string
  by: Author
  account?: AccountKey
  target?: string
  payload?: unknown
  reason?: string
}

export interface ProposedActionsStore {
  propose(input: ProposalInput): Promise<ProposedAction>
  get(id: string): Promise<ProposedAction>
  /** What waits for a decision, oldest first. */
  pending(options?: { limit?: number }): Promise<ProposedAction[]>
  /** Newest first; every status unless one is named. */
  list(options?: { status?: ProposedAction["status"]; limit?: number }): Promise<ProposedAction[]>
  /** `result` records what the approval made, such as the task it became. */
  approve(id: string, result?: unknown): Promise<ProposedAction>
  reject(id: string): Promise<ProposedAction>
  /** An approved action the adapter carried out, with what the provider answered. */
  executed(id: string, result?: unknown): Promise<ProposedAction>
  failed(id: string, error: string): Promise<ProposedAction>
  judge(id: string, verdict: ProposedAction["verdict"]): Promise<ProposedAction>
}

export const PROPOSAL_STATUSES = ["proposed", "approved", "rejected", "executed", "failed"] as const

export const PROPOSAL_VERDICTS = ["useful", "not_useful"] as const
