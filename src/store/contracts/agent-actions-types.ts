import type { Actor } from "../sqlite/actors.js"
import type { Author } from "../sqlite/memories.js"

/**
 * One tool call as the audit trail keeps it: who, which tool, at what tier, on what, how it ended. Never the
 * arguments or the answer: `error` is a short code, not a message that could quote them.
 */
export interface AgentActionInput {
  actor: Author
  tool: string
  tier: (typeof ACTION_TIERS)[number]
  /** A reference to what it acted on, when the caller knows one. */
  target?: string
  status: (typeof ACTION_OUTCOMES)[number]
  error?: string
  startedAt: number
  finishedAt: number
}

export interface AgentAction {
  id: string
  /** `name` is a bot's handle; `null` for a person. */
  actor: { type: Actor["type"]; id: string; name: string | null }
  tool: string
  tier: AgentActionInput["tier"]
  target: { type: string; id: string } | null
  status: AgentActionInput["status"]
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export interface AgentActionsStore {
  record(input: AgentActionInput): Promise<AgentAction>
  /** Newest first; `agent` is a bot's name, such as `tg-mcp`. */
  list(options?: { tool?: string; agent?: string; limit?: number }): Promise<AgentAction[]>
}

export const ACTION_TIERS = ["read", "draft", "write-private", "write-public", "destructive", "admin"] as const

export const ACTION_OUTCOMES = ["ok", "refused", "failed"] as const
