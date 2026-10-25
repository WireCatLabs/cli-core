import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"

export const CONTEXT_MAX_READ_BYTES = 262144
export const CONTEXT_SOURCE_KINDS = ["message", "mail", "document", "meeting"] as const
export interface ContextSource {
  kind: (typeof CONTEXT_SOURCE_KINDS)[number]
  accountId: number
  provider: string
  account: string
}
export interface ContextEvidenceRequest {
  source: ContextSource
  /** Required unless `chat` is given; a chat read takes no query. */
  query?: string
  /** One stored chat or mail thread of the source's account, by its external id; refused for documents and meetings. */
  chat?: string
  /** Messages or mail written by these identities of the source's provider (mail: addresses); no query or chat. */
  senders?: string[]
  after: number
  before: number
  limit?: number
  maxReadBytes?: number
  cursor?: { at: number; id: number; scope: string }
  signal?: AbortSignal
}
export interface ContextEvidenceItem {
  ref: string
  provider: string
  account: string
  title: string | null
  url: string | null
  text: string
  at: number
  timeKind: "sent" | "source-modified" | "stored-update" | "meeting-start"
  updatedAt: number
  revision: number | null
  /** Who wrote a message or email, as stored; absent for documents and meeting cues. */
  sender?: ContextEvidenceSender | null
}
export interface ContextEvidenceSender {
  provider: string
  /** The identity's id in its provider; an email address for mail. */
  id: string
  name: string | null
  /** `person:<id>` when the store links the identity to a person. */
  person: string | null
  personName: string | null
  /** The identity is the owner's: linked to the owner person, or the account's own. */
  owner: boolean
}
export interface ContextEvidencePage {
  source: ContextSource
  items: ContextEvidenceItem[]
  next: { at: number; id: number; scope: string } | null
  readBytes: number
  /** The next record alone is larger than maxReadBytes: it was not read, and next moves past it. */
  oversized?: { ref: string; bytes: number }
  coverage: {
    available: boolean
    index: "ready" | "pending" | "missing" | "unknown"
    hasMore: boolean
    hasUndated: boolean
    completeness: "unknown"
    matching: "literal-words" | "chat" | "sender"
    consistency: "snapshot-per-page"
  }
}
export interface ContextEvidenceReader {
  read(request: ContextEvidenceRequest): Promise<ContextEvidencePage>
}

/** Brings the word index of stored mail and imported documents up to date, so the reads that follow find new text. */
export interface ContextIndex {
  catchUp(request: { kinds: readonly ContextSource["kind"][]; signal?: AbortSignal }): Promise<{
    mail: number
    documents: number
  }>
}

/** Changes whenever the cited text, its title or its revision does; a staged finding citing an older one is stale. */
export const contextEvidenceFingerprint = (item: Pick<ContextEvidenceItem, "ref" | "title" | "text" | "revision">) =>
  createHash("sha256")
    .update(JSON.stringify(["context-evidence-v1", item.ref, item.title, item.text, item.revision]))
    .digest("hex")

/** How many rows, in reading order, fit the allowance together; none when the first alone is larger. */
export const fittingRows = (sizes: readonly number[], limit: number, maxReadBytes: number) => {
  let count = 0,
    bytes = 0
  for (const size of sizes.slice(0, limit)) {
    if (!(bytes + size <= maxReadBytes)) break
    bytes += size
    count++
  }
  return { count, bytes }
}

/** One stored message, email or document as the context reader returns it, by its reference. */
export interface ContextRecordReader {
  read(ref: string): Promise<Pick<ContextEvidenceItem, "ref" | "title" | "text" | "revision"> | null>
}

export const contextCursorScope = (
  request: Pick<ContextEvidenceRequest, "source" | "query" | "chat" | "senders" | "after" | "before">,
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "context-evidence-v1",
        request.source.kind,
        request.source.accountId,
        request.source.provider,
        request.source.account,
        request.query ?? null,
        request.after,
        request.before,
        // Only a chat read hashes its chat, so cursors issued before chat reads existed stay valid.
        ...(request.chat === undefined ? [] : [request.chat]),
        ...(request.senders === undefined ? [] : [["senders", ...request.senders]]),
      ]),
    )
    .digest("hex")

const fields = (value: object, allowed: readonly string[], prefix: string) => {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new CliError("validation_error", `${prefix}${unknown} is not supported`)
}

export const contextSource = (value: ContextSource): ContextSource => {
  if (
    !value ||
    !CONTEXT_SOURCE_KINDS.includes(value.kind) ||
    !Number.isSafeInteger(value.accountId) ||
    value.accountId < 1
  )
    throw new CliError("validation_error", "source needs a known kind and a positive accountId")
  fields(value, ["kind", "accountId", "provider", "account"], "source.")
  for (const [key, max] of [
    ["provider", 128],
    ["account", 1024],
  ] as const)
    if (typeof value[key] !== "string" || !value[key].trim() || Buffer.byteLength(value[key]) > max)
      throw new CliError("validation_error", `source.${key} needs 1–${max} UTF-8 bytes`)
  return { kind: value.kind, accountId: value.accountId, provider: value.provider, account: value.account }
}

export const contextEvidenceRequest = (input: ContextEvidenceRequest) => {
  const source = contextSource(input?.source)
  fields(
    input,
    ["source", "query", "chat", "senders", "after", "before", "limit", "maxReadBytes", "cursor", "signal"],
    "",
  )
  const integer = (value: number, name: string, low: number, high: number) => {
    if (!Number.isSafeInteger(value) || value < low || value > high)
      throw new CliError("validation_error", `${name} must be a whole number from ${low} to ${high}`)
    return value
  }
  const after = integer(input.after, "after", 0, 8_640_000_000_000_000)
  const before = integer(input.before, "before", after + 1, 8_640_000_000_000_000)
  if (before - after > 90 * 86400000)
    throw new CliError("validation_error", "context time window must not exceed 90 days")
  const chat = input.chat
  if (chat !== undefined) {
    if (typeof chat !== "string" || !chat.trim() || Buffer.byteLength(chat) > 1024)
      throw new CliError("validation_error", "chat needs 1–1024 UTF-8 bytes")
    if (source.kind !== "message" && source.kind !== "mail")
      throw new CliError("validation_error", "only a message or mail source reads one chat")
    if (input.query !== undefined) throw new CliError("validation_error", "a chat read takes no query")
  }
  const senders = input.senders
  if (senders !== undefined) {
    if (
      !Array.isArray(senders) ||
      !senders.length ||
      senders.length > 16 ||
      senders.some((id) => typeof id !== "string" || !id.trim() || Buffer.byteLength(id) > 1024) ||
      new Set(senders).size !== senders.length
    )
      throw new CliError("validation_error", "senders needs 1–16 distinct identity ids")
    if (source.kind !== "message" && source.kind !== "mail")
      throw new CliError("validation_error", "only a message or mail source reads by sender")
    if (input.query !== undefined || chat !== undefined)
      throw new CliError("validation_error", "a sender read takes no query or chat")
  }
  const bare = chat === undefined && senders === undefined
  const query = input.query
  if (bare && (typeof query !== "string" || !query.trim() || Buffer.byteLength(query) > 2048))
    throw new CliError("validation_error", "query needs 1–2048 UTF-8 bytes of literal words")
  const words = query?.match(/[\p{L}\p{N}]+/gu) ?? []
  if (bare && (!words.length || words.length > 16))
    throw new CliError("validation_error", "query needs 1–16 literal words")
  const limit = integer(input.limit ?? 10, "limit", 1, 20)
  const maxReadBytes = integer(input.maxReadBytes ?? 65536, "maxReadBytes", 1, CONTEXT_MAX_READ_BYTES)
  if (input.cursor !== undefined && (!input.cursor || typeof input.cursor !== "object"))
    throw new CliError("validation_error", "cursor needs at, id and scope")
  if (input.cursor) fields(input.cursor, ["at", "id", "scope"], "cursor.")
  const cursor =
    input.cursor === undefined
      ? undefined
      : {
          at: integer(input.cursor.at, "cursor.at", after, before - 1),
          id: integer(input.cursor.id, "cursor.id", 1, Number.MAX_SAFE_INTEGER),
          scope: input.cursor.scope,
        }
  if (cursor && cursor.scope !== contextCursorScope({ source, query, chat, senders, after, before }))
    throw new CliError("validation_error", "cursor belongs to another source, query, chat, senders or time window")
  return { source, query, chat, senders, words, after, before, limit, maxReadBytes, cursor, signal: input.signal }
}
