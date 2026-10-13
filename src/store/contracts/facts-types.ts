import type { Actor } from "../sqlite/actors.js"
import type { Author, MEMORY_SCOPES } from "./memories-types.js"

/** What happened, as its evidence shows; its evidence is `links` of kind `evidence`. */
export interface Fact {
  id: string
  ref: string
  type: (typeof FACT_TYPES)[number]
  statement: string
  /** Every fact is proposed or accepted; only a decision is also superseded or reversed. */
  status: (typeof FACT_STATUSES)[number]
  project: string | null
  subject: string | null
  occurredAt: string | null
  supersedes: string | null
  /** `name` is a bot's handle; `null` for a person. */
  author: { type: Actor["type"]; id: string; name: string | null }
  model: string | null
  confirmedBy: { type: Actor["type"]; id: string } | null
  scope: (typeof MEMORY_SCOPES)[number] | null
  source: string
  evidence: string[]
  createdAt: string
  updatedAt: string
}

export interface FactInput {
  type: Fact["type"]
  statement: string
  /** Who records it: the owner's is accepted at once, an agent's waits as proposed. */
  by: Author
  project?: string
  subject?: string
  /** When it happened, as the evidence shows (ISO). */
  occurredAt?: string
  evidence?: string[]
  scope?: Fact["scope"] & string
  /** A decision only: the decision this one replaces, `superseded` once this one is accepted. */
  supersedes?: string
  /** The memory an agent drew it from: a `created-from` link. */
  createdFrom?: string
}

export interface FactsStore {
  add(input: FactInput): Promise<Fact>
  get(reference: string): Promise<Fact>
  list(options?: {
    type?: Fact["type"]
    project?: string
    subject?: string
    status?: Fact["status"]
    limit?: number
  }): Promise<Fact[]>
  /** The owner accepts a proposed fact; a decision it supersedes stops holding. */
  accept(reference: string): Promise<Fact>
  /** An accepted decision no longer holds and nothing replaced it. */
  reverse(reference: string): Promise<Fact>
}

export const FACT_TYPES = ["fact", "statement", "question", "decision", "promise"] as const

export const FACT_STATUSES = ["proposed", "accepted", "superseded", "reversed"] as const
