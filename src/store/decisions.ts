import { CliError } from "@wirecat/cli-base"

/**
 * Who proposed something waiting for the owner. `unknown` is a suggestion that names no author, such as an
 * unconfirmed link written without provenance: only the owner decides it. `verified: false` is a bot named only by
 * free text anyone could write, as an old suggested link's provenance: only the owner decides that one too.
 */
export type Proposer =
  | { type: "person"; id: string }
  | { type: "bot"; id: string; name: string; kind: "agent" | "rule"; verified?: false }
  | { type: "unknown" }

/** Who decides: the owner, or an agent the host lets decide for the owner, with its reason. */
export type Decider = "owner" | { bot: string; model?: string; reason: string }

export interface DecisionPolicy {
  /** The host's `agent_decisions`: `false` keeps every decision with the owner. */
  agentDecisions: boolean
  /** A rule scorer's proposal is the owner's alone to decide. */
  ruleProposalsOwnerOnly: boolean
}

export const DEFAULT_DECISION_POLICY: DecisionPolicy = { agentDecisions: true, ruleProposalsOwnerOnly: true }

export interface Refusal {
  id: string
  code: "permission_error" | "validation_error" | "not_found"
  reason: string
  message: string
}

/**
 * The one check every decide path runs before it confirms or rejects a proposal. `null` means allowed. Every Claude
 * Code session is the bot `claude-code`, so comparing bot names keeps one session from deciding another's proposal.
 */
export const mayDecide = (
  row: { id: string; proposedBy: Proposer },
  by: Decider,
  policy: DecisionPolicy = DEFAULT_DECISION_POLICY,
): Refusal | null => {
  if (by === "owner") return null
  const refuse = (code: Refusal["code"], reason: string, message: string): Refusal => ({
    id: row.id,
    code,
    reason,
    message,
  })
  if (!policy.agentDecisions)
    return refuse(
      "permission_error",
      "proposals.agent-decisions-off",
      "agent decisions are turned off; the owner decides",
    )
  if (typeof by.reason !== "string" || !by.reason.trim() || by.reason.length > 2000)
    return refuse("validation_error", "proposal.reason-required", "an agent deciding for the owner gives a reason")
  const proposer = row.proposedBy
  if (proposer.type === "unknown")
    return refuse("permission_error", "proposal.owner-only", "this proposal names no author; only the owner decides it")
  if (proposer.type === "bot" && proposer.verified === false)
    return refuse(
      "permission_error",
      "proposal.owner-only",
      `${proposer.name} is named only by an old link's provenance; only the owner decides it`,
    )
  if (proposer.type === "bot" && proposer.kind === "rule" && policy.ruleProposalsOwnerOnly)
    return refuse("permission_error", "proposal.owner-only", `proposed by ${proposer.name}: only the owner decides it`)
  if (proposer.type === "bot" && proposer.kind === "agent" && botKey(proposer.name) === botKey(by.bot))
    return refuse("permission_error", "proposal.own", `${by.bot} proposed this; another decider must decide it`)
  return null
}

/** One bot whatever its letter case or spacing: `Claude-Code` is `claude-code`. */
export const botKey = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")

/**
 * Removing or reversing a row: the owner always may; an agent only withdraws its own row while it is still
 * proposed. Everything else stays the owner's.
 */
export const assertMayWithdraw = (
  row: { id: string; proposedBy: Proposer; proposed: boolean },
  by: Decider | Exclude<Decider, "owner"> | { bot: string },
): void => {
  if (by === "owner") return
  const proposer = row.proposedBy
  if (
    row.proposed &&
    proposer.type === "bot" &&
    proposer.kind === "agent" &&
    proposer.verified !== false &&
    botKey(proposer.name) === botKey(by.bot)
  )
    return
  throw new CliError("permission_error", `only the owner removes or reverses ${row.id}`, {
    reason: "proposal.owner-only",
  })
}

/** `mayDecide` for a store method: throws the refusal instead of returning it. */
export const assertMayDecide = (
  row: { id: string; proposedBy: Proposer },
  by: Decider,
  policy: DecisionPolicy = DEFAULT_DECISION_POLICY,
): void => {
  const refusal = mayDecide(row, by, policy)
  if (refusal) throw new CliError(refusal.code, refusal.message, { reason: refusal.reason })
}

/** The author a decision is recorded under. */
export const deciderAuthor = (by: Decider): "owner" | { bot: string; model?: string } =>
  by === "owner" ? "owner" : { bot: by.bot, ...(by.model === undefined ? {} : { model: by.model }) }
