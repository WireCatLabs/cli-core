import type { Id } from "../domain/models.js"
import type { RemoteModel } from "../embeddings/remote.js"
import type { AccountKey, ConversationSummary } from "../store/store.js"
import type { Built } from "./conversations.js"
import type { ServiceDeps } from "./deps.js"
import { embeddingsMaintenance } from "./embeddings-maintenance.js"
import { embeddingsSearch } from "./embeddings-search.js"
import type { SearchRefreshed, SyncOptions } from "./search-refresh.js"

export { REFRESH_BOUNDS } from "./embeddings-maintenance.js"

/** A local model by id (the default when nothing is given), or a remote one with the user's key (E11). */
export type ModelChoice = string | { remote: RemoteModel; apiKey?: string; concurrency?: number }

export interface EmbedStatus {
  chat: Id
  model: string
  /** The current build's distinct chunk texts. */
  chunks: number
  embedded: number
  left: number
  /** A local model at its measured speed on one session; `null` for a remote one. */
  estimateSeconds: number | null
  /** At most this many tokens are sent for what is left — a chunk is at most `CHUNK_CHARS` characters. */
  tokensAtMost: number
  /** For a remote model with a known price: at most this many US dollars for what is left. */
  priceAtMost?: { usd: number; read: string }
}

export interface Embedded {
  chat: Id
  model: string
  embedded: number
  /** Chunks whose messages changed since the build: `conversations links rebuild` cuts them again. */
  skipped: number
}

export interface EmbeddingsService {
  status(chat: string, model?: ModelChoice): Promise<EmbedStatus>
  /** Embeds every chunk of the chat's current build that has no vector of the model, a batch at a time. */
  embed(
    chat: string,
    options: {
      model?: ModelChoice
      threads?: number
      /** Stops after this many chunks; the next run resumes. */
      maxChunks?: number
      progress?: (done: number, left: number) => void
    },
  ): Promise<Embedded>
  /** Drops the chat's vectors, or one model's; messages and conversations are never touched. */
  clear(chat: string, model?: ModelChoice): Promise<{ chat: Id; cleared: number }>
  /**
   * The conversations nearest in meaning to `query`, in one chat or every one of the account (E7). With no
   * local model downloaded it answers by words alone (NEED-552 A): never a download, never a remote model.
   */
  search(
    query: string,
    options: {
      chat?: string
      model?: ModelChoice
      since?: string
      limit: number
      filter?: string
      source?: string
      timezone?: string
      syncFirst?: SyncOptions
      signal?: AbortSignal
      /** Local graph catch-up after any network refresh and before searching. */
      refresh?: RefreshOptions
    },
  ): Promise<FoundConversations>
  /**
   * The conversations of every built chat nearest in meaning to the one `message` is in, best first, never that
   * one: the mean of its current vectors is the query, so no model runs and none need be downloaded.
   */
  related(chat: string, message: Id, options: { model?: ModelChoice; limit: number }): Promise<RelatedConversations>
  /**
   * How fresh one chat's conversations and vectors are, or every built chat's — and then how many group chats
   * were never built, which `conversations links rebuild` would also do.
   */
  readiness(options: {
    chat?: string
    model?: ModelChoice
  }): Promise<{ model: string; chats: ChatReadiness[]; unbuiltGroups?: number }>
  /**
   * Builds and embeds, on this machine, the chats that changed or were never built — one chat, or every built
   * chat and every group chat never built — within the bounds (NEED-551 A). Never downloads a model.
   */
  refresh(options: RefreshOptions): Promise<Refreshed>
}

export interface RefreshOptions {
  maxMessages?: number
  check?: () => void
  chat?: string
  /** A local model id; a remote model is only ever chosen per chat, with the owner's yes. */
  model?: string
  build?: boolean
  embed?: boolean
  maxChats?: number
  maxChunks?: number
  threads?: number
  progress?: (note: string) => void
  /** With the default local model, also each message's own vector, which `--discover` reads; `false` skips it. */
  messages?: boolean
}

export interface Refreshed {
  model: string
  /** `false`: the model is not downloaded, so nothing was embedded. */
  modelAvailable: boolean
  built: Built[]
  embedded: Embedded[]
  /** Chats still needing a build or vectors after this run: over a bound, or the model is missing. */
  left: { chat: Id; needs: "build" | "embed" }[]
  /** Messages given their own vector by this run, and how many still lack one; only when they were looked at. */
  messages?: { embedded: number; left: number }
}

export interface FoundConversations {
  accounts?: AccountKey[]
  prepared?: Refreshed
  refreshed?: SearchRefreshed
  coverage?: { state: "partial" | "stale" }
  model: string
  /** `unavailable`: the local model is not downloaded, and only words were searched. */
  meaning: "searched" | "unavailable"
  hits: FoundConversation[]
  readiness: SearchReadiness
  /** Kept for callers of 0.141.0 and before; `readiness.wordsOnly` says more. */
  embeddedOnlyElsewhere: Id[]
}

export interface RelatedConversations {
  model: string
  /** The conversation the message is in. */
  source: ConversationSummary
  hits: FoundConversation[]
  readiness: SearchReadiness
}

/** Chat ids by how the search could see them; a chat can be in more than one list. */
export interface SearchReadiness {
  scopes?: { source: AccountKey; readiness: SearchReadiness }[]
  /** Built chats with vectors of the model. */
  searchedByMeaning: Id[]
  /** Built chats with no vector of the model, or every built chat when the model is unavailable. */
  wordsOnly: Id[]
  /** Searched by meaning, but some chunks have no vector yet: `conversations embed`. */
  partial: Id[]
  /** Messages or rules changed since the build: `conversations links rebuild`. */
  stale: Id[]
  /** Never built, so their matches cannot be shown: `conversations links rebuild`. */
  notBuilt: Id[]
}

export type ReadinessState = "ready" | "stale" | "partial" | "words-only" | "not-built"

export interface ChatReadiness {
  chat: Id
  state: ReadinessState
  graph: { builtAt: string; rulesVersion: number | null; outdatedRules: boolean } | null
  pending: { new: number; edited: number; deleted: number }
  /** The current build's distinct chunk texts, by their vector of the model: `current` + `stale` + `missing`. */
  vectors: { chunks: number; current: number; stale: number; missing: number }
}

/** A conversation found by meaning, by words, or both (E9). */
export interface FoundConversation {
  source?: AccountKey
  locator?: string
  summary: ConversationSummary
  /** The chunk nearest in meaning; the best message found by words when only words found it. */
  chunk: { firstMessageId: Id; lastMessageId: Id }
  /** The best chunk's cosine, −1 to 1; `null` when only words found it. */
  score: number | null
  /** `context`: the hit is an image, found by the messages around it; its message is `chunk`. */
  matchedIn?: "context"
  by: ("meaning" | "words")[]
  /** The chunk's text changed after it was embedded: the score is for what it said then (NEED-550 B). */
  stale: boolean
}

export const embeddingsService = (deps: ServiceDeps): EmbeddingsService => ({
  ...embeddingsMaintenance(deps),
  ...embeddingsSearch(deps),
})
