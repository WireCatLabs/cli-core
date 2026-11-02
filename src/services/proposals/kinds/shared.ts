import type { Proposer } from "../../../store/decisions.js"
import type { ProposalFilter, ProposalRow } from "../types.js"

/** A fact's or memory's author as a proposer; the store's own check reads the bot's kind from its row. */
export const proposerOfAuthor = (author: { type: "person" | "bot"; id: string; name: string | null }): Proposer => {
  if (author.type === "person") return { type: "person", id: author.id }
  if (author.name === null) return { type: "unknown" }
  return { type: "bot", id: author.id, name: author.name, kind: author.name === "rule" ? "rule" : "agent" }
}

const byMatches = (row: ProposalRow, by: ProposalFilter["by"]): boolean => {
  if (by === undefined) return true
  const proposer = row.proposedBy
  if (proposer.type !== "bot") return false
  if (by === "agent" || by === "rule") return proposer.kind === by
  return proposer.name === by.bot
}

/** What a kind keeps of the rows it read: the filter's status and proposer, newest first, at most `limit`. */
export const kept = (rows: ProposalRow[], filter: ProposalFilter): ProposalRow[] => {
  const status = filter.status ?? "proposed"
  return rows
    .filter((row) => (status === "all" || row.status === status) && byMatches(row, filter.by))
    .filter((row) => filter.project === undefined || row.project === filter.project)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, filter.limit)
}

/** How many rows a kind reads to fill a page after filtering in memory. */
export const reading = (filter: ProposalFilter): number => Math.min(500, filter.limit * (filter.by ? 4 : 1))

/** A suggestion an agent or a rule wrote; Drive's editor links and other records stay out of the inbox. */
export const proposedLink = (provenance: string | null): boolean => /^(agent|rule):/.test(provenance ?? "")

export const projectOf = (...refs: (string | null | undefined)[]): string | null =>
  refs.find((ref): ref is string => typeof ref === "string" && ref.startsWith("project:")) ?? null

const ACTION_STATUS: Record<string, ProposalRow["status"]> = {
  proposed: "proposed",
  approved: "confirmed",
  executed: "confirmed",
  failed: "confirmed",
  rejected: "rejected",
}
export const actionStatus = (status: string): ProposalRow["status"] => ACTION_STATUS[status] ?? "proposed"

/** The stored statuses a filter's status reads, so the store does the filtering when it can. */
export const storedStatus = (filter: ProposalFilter): "proposed" | "rejected" | undefined => {
  const status = filter.status ?? "proposed"
  return status === "proposed" || status === "rejected" ? status : undefined
}
