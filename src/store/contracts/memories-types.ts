import type { Actor } from "../sqlite/actors.js"
import type { NoteIndexState } from "../sqlite/note-index.js"

/** Who wrote it: the owner, or an agent by its bot handle and the model it ran on. */
export type Author = "owner" | { bot: string; model?: string }

export interface Memory {
  id: string
  ref: string
  kind: (typeof MEMORY_KINDS)[number]
  body: string
  /** What it is about, as a reference; `null` for a general fact. */
  subject: string | null
  /** `name` is a bot's handle; `null` for a person. */
  author: { type: Actor["type"]; id: string; name: string | null }
  model: string | null
  confidence: number | null
  status: (typeof MEMORY_STATUSES)[number]
  scope: (typeof MEMORY_SCOPES)[number]
  supersedes: string | null
  /** The references it rests on: `links` of kind `evidence`. */
  evidence: string[]
  lastVerifiedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface MemoryInput {
  kind: Memory["kind"]
  body: string
  /** Required, with no default: a memory read for the wrong purpose leaks, so its writer says which. */
  scope: Memory["scope"]
  /** At least one reference the memory rests on. */
  evidence: string[]
  author: Author
  subject?: string
  confidence?: number
  status?: "proposed" | "confirmed"
  /** The memory this one replaces; it becomes `superseded`. */
  supersedes?: string
}

export interface MemoriesStore {
  add(input: MemoryInput): Promise<Memory>
  get(reference: string): Promise<Memory>
  list(options?: {
    subject?: string
    kind?: Memory["kind"]
    status?: Memory["status"]
    scope?: Memory["scope"]
    limit?: number
  }): Promise<Memory[]>
  /** The owner stands behind it; its evidence was checked now. */
  confirm(reference: string): Promise<Memory>
  /** Its evidence no longer holds. */
  markStale(reference: string): Promise<Memory>
  /** Indexes what was written since, then finds memories holding every word or a longer one it starts, best first. */
  search(text: string, options?: { scope?: Memory["scope"]; limit?: number }): Promise<Memory[]>
  indexState(): Promise<NoteIndexState>
}

export const MEMORY_KINDS = ["summary", "digest", "preference"] as const

export const MEMORY_STATUSES = ["proposed", "confirmed", "stale", "superseded"] as const

export const MEMORY_SCOPES = ["personal", "work"] as const
