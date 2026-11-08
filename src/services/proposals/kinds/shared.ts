import type { DecidedType } from "../../../domain/record-types.js"
import type { Proposer } from "../../../store/decisions.js"
import type { Decision, ProposalFilter, ProposalKind, ProposalRow } from "../types.js"

/** A stored author as a proposer, with the kind read from its bot row. */
export const proposerOfAuthor = (author: {
  type: "person" | "bot"
  id: string
  name: string | null
  kind: "agent" | "rule" | null
}): Proposer => {
  if (author.type === "person") return { type: "person", id: author.id }
  if (author.name === null) return { type: "unknown" }
  return { type: "bot", id: author.id, name: author.name, kind: author.kind ?? "agent" }
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

/** The filters every store list takes, so a page is filled by the query and not cut after it. */
export const pushed = (filter: ProposalFilter) => ({
  ...(filter.project === undefined ? {} : { project: filter.project }),
  ...(filter.by === undefined ? {} : { proposedBy: filter.by }),
  limit: Math.min(filter.limit, 500),
})

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

/** What a reviewed store entry shows in the inbox: its own ref is the proposal's id. */
export interface ReviewedEntry {
  ref: string
  review: "proposed" | "confirmed" | "rejected"
  project: string | null
  title: string
  author: Parameters<typeof proposerOfAuthor>[0]
  reason: string | null
  createdAt: string
}

export const reviewedRow = (kind: string, entry: ReviewedEntry, object: string | null): ProposalRow => ({
  id: entry.ref,
  kind,
  status: entry.review,
  project: entry.project,
  subject: entry.ref,
  object,
  summary: entry.title,
  proposedBy: proposerOfAuthor(entry.author),
  reason: entry.reason,
  evidence: [],
  score: null,
  signals: null,
  parts: null,
  createdAt: entry.createdAt,
})

/**
 * A kind over a store whose rows carry `review`, routed by its own prefix as invoices are. Only the owner decides
 * money: the store refuses an agent whatever the policy says.
 */
export const reviewedKind = <T>(spec: {
  /** A type the record registry marks reviewed: its kind and its ref prefix both. */
  type: DecidedType
  list: (options: ReturnType<typeof pushed> & { review?: "proposed" | "confirmed" | "rejected" }) => Promise<T[]>
  get: (id: string) => Promise<T>
  row: (entry: T) => ProposalRow
  decide: (id: string, confirm: boolean, decision: Pick<Decision, "by" | "reason">) => Promise<string>
}): ProposalKind => ({
  kind: spec.type,
  prefix: spec.type,
  list: async (filter) => {
    const status = filter.status ?? "proposed"
    const entries = await spec.list({ ...pushed(filter), ...(status === "all" ? {} : { review: status }) })
    return kept(entries.map(spec.row), filter)
  },
  get: async (id) => spec.row(await spec.get(id)),
  decide: async (id, { confirm, by, reason }) => {
    const made = await spec.decide(id, confirm, { by, reason })
    return { id, kind: spec.type, status: confirm ? "confirmed" : "rejected", made: confirm ? [made] : [] }
  },
})
