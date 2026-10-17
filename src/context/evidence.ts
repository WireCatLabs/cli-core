import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"

export const CONTEXT_SOURCE_KINDS = ["message", "mail", "document"] as const
export interface ContextSource {
  kind: (typeof CONTEXT_SOURCE_KINDS)[number]
  accountId: number
  provider: string
  account: string
}
export interface ContextEvidenceRequest {
  source: ContextSource
  query: string
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
  timeKind: "sent" | "source-modified" | "stored-update"
  updatedAt: number
  revision: number | null
}
export interface ContextEvidencePage {
  source: ContextSource
  items: ContextEvidenceItem[]
  next: { at: number; id: number; scope: string } | null
  readBytes: number
  coverage: {
    available: boolean
    index: "ready" | "pending" | "missing" | "unknown"
    hasMore: boolean
    hasUndated: boolean
    completeness: "unknown"
    matching: "literal-words"
    consistency: "snapshot-per-page"
  }
}
export interface ContextEvidenceReader {
  read(request: ContextEvidenceRequest): Promise<ContextEvidencePage>
}

export const contextCursorScope = (request: Pick<ContextEvidenceRequest, "source" | "query" | "after" | "before">) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        request.source.kind,
        request.source.accountId,
        request.source.provider,
        request.source.account,
        request.query,
        request.after,
        request.before,
      ]),
    )
    .digest("hex")

export const contextSource = (value: ContextSource): ContextSource => {
  if (
    !value ||
    !CONTEXT_SOURCE_KINDS.includes(value.kind) ||
    !Number.isSafeInteger(value.accountId) ||
    value.accountId < 1
  )
    throw new CliError("validation_error", "source needs a known kind and a positive accountId")
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
  const integer = (value: number, name: string, low: number, high: number) => {
    if (!Number.isSafeInteger(value) || value < low || value > high)
      throw new CliError("validation_error", `${name} must be a whole number from ${low} to ${high}`)
    return value
  }
  const after = integer(input.after, "after", 0, 8_640_000_000_000_000)
  const before = integer(input.before, "before", after, 8_640_000_000_000_000)
  if (typeof input.query !== "string" || !input.query.trim() || Buffer.byteLength(input.query) > 2048)
    throw new CliError("validation_error", "query needs 1–2048 UTF-8 bytes of literal words")
  const words = input.query.match(/[\p{L}\p{N}]+/gu) ?? []
  if (!words.length || words.length > 16) throw new CliError("validation_error", "query needs 1–16 literal words")
  const limit = integer(input.limit ?? 10, "limit", 1, 20)
  const maxReadBytes = integer(input.maxReadBytes ?? 65536, "maxReadBytes", 1, 1048576)
  if (input.cursor !== undefined && (!input.cursor || typeof input.cursor !== "object"))
    throw new CliError("validation_error", "cursor needs at, id and scope")
  const cursor =
    input.cursor === undefined
      ? undefined
      : {
          at: integer(input.cursor.at, "cursor.at", after, before),
          id: integer(input.cursor.id, "cursor.id", 1, Number.MAX_SAFE_INTEGER),
          scope: input.cursor.scope,
        }
  if (cursor && cursor.scope !== contextCursorScope(input))
    throw new CliError("validation_error", "cursor belongs to another source, query or time window")
  return { source, words, after, before, limit, maxReadBytes, cursor, signal: input.signal }
}
