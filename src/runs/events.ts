/**
 * One operation against the messenger, as both sinks see it: `--trace` renders it, a recorded run
 * writes it as a line of JSON.
 *
 * ⚠ **Nothing here may carry content.** An operation name, an id, a file or folder path, a count, a duration and an
 * error code are safe: a run record stays on the owner's machine, and keeping the ids that tell runs apart was the
 * owner's choice (NEED-110, 2026-10-27). A chat title, a name, a message body, a phone number, a token, a URL as sent
 * or a query string are not — not truncated and not hashed. The adapter builds `ids` and `counts` from fields it names,
 * never by copying a request, and never from what the person typed: a typed chat is often a title. Anything that
 * leaves the machine (a bug report) strips the ids too.
 */
export interface RequestEvent {
  event: "request" | "response"
  /** Ours, not the messenger's: `messages.send`. */
  operation: string
  /** A frame protocol's own numbering (max-cli's personal protocol); an HTTP API says `status` instead. */
  opcode?: number
  seq?: number
  status?: number
  /** An HTTP API's verb, `POST`. */
  method?: string
  /** The path it went to with ids as `:id` and no query string — `/chats/:id/messages`. Never the URL as sent. */
  endpointTemplate?: string
  /** The size of what went out or came back. */
  bytes?: number
  ids?: Record<string, string>
  /** How many things, per field: `{ messages: 3 }`. */
  counts?: Record<string, number>
  durationMs?: number
  outcome?: "ok" | "error"
  /** cli-base's code — `timeout`, `provider_error`. Never the message: a messenger quotes our payload. */
  errorCode?: string
  /** The messenger's own name for a refusal, when it is shaped like one (`providerErrorKey`). */
  providerError?: string
  /**
   * `operation` for one adapter call (`observed`), `wire` for one call on the network under it. A run counts wire
   * requests when it has any, so one operation over three frames is three requests, never four.
   */
  level?: "operation" | "wire"
  transport?: "http" | "mtproto" | "max-ws" | "wa-engine"
  /** 1 for the first try, 2 and up for a retry of the same call. */
  attempt?: number
  /** How long the client waited before this attempt: a flood wait or a `Retry-After`. */
  waitMs?: number
}

/** Something the client noticed and went on without. A code, never the sentence. */
export interface WarningEvent {
  event: "warning"
  code: string
  operation?: string
  /** Field paths and types for an answer of an unexpected shape — built without the values. */
  detail?: string
  /** How many things the warning is about, per field: `{ rekeys: 199 }`. */
  counts?: Record<string, number>
}

/** A read answered locally, without asking the messenger, and why. */
export interface CacheEvent {
  event: "cache"
  operation: string
  reason: string
  ids?: Record<string, string>
  counts?: Record<string, number>
  /** How old the kept answer was. */
  ageMs?: number
}

export type DiagnosticEvent = RequestEvent | CacheEvent | WarningEvent

export type EventSink = (event: DiagnosticEvent) => void

/** A sentence for a person, and the warning event it stands for when there is one: a log record keeps only the event. */
export type Warn = (message: string, warning?: WarningEvent) => void

/** `FLOOD_WAIT`, `PEER_ID_INVALID`, `login.token` — or nothing. A sentence is dropped, not trimmed. */
export const providerErrorKey = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value) ? value : undefined

/**
 * The line a person reads. `→` is what we asked, `←` what came back.
 *
 * ```text
 * → messages.list    chat 777
 * ← messages.list    chat 777  118ms  3 messages
 * ```
 */
export const renderEvent = (event: DiagnosticEvent): string => {
  if (event.event === "warning") {
    const counts = Object.entries(event.counts ?? {}).map(([field, count]) => `${count} ${field}`)
    return [`${MARK.warning} ${(event.operation ?? "").padEnd(16)} ${event.code}`, ...counts, event.detail]
      .filter(Boolean)
      .join("  ")
  }

  const parts: string[] = []
  if (event.event === "cache") {
    parts.push(event.reason)
    if (event.ageMs !== undefined) parts.push(`cached ${age(event.ageMs)}`)
  } else {
    if (event.opcode !== undefined) parts.push(`op ${event.opcode}`, `seq ${event.seq}`)
    if (event.method !== undefined || event.endpointTemplate !== undefined)
      parts.push([event.method, event.endpointTemplate].filter(Boolean).join(" "))
    if (event.status !== undefined) parts.push(`${event.status}`)
    if (event.attempt !== undefined && event.attempt > 1) parts.push(`attempt ${event.attempt}`)
    if (event.waitMs !== undefined) parts.push(`waited ${age(event.waitMs)}`)
  }
  if (event.ids) for (const [name, value] of Object.entries(event.ids)) parts.push(`${name} ${value}`)
  if (event.event !== "cache") {
    if (event.durationMs !== undefined) parts.push(`${event.durationMs}ms`)
    if (event.bytes !== undefined) parts.push(size(event.bytes))
  }
  if (event.counts) for (const [field, count] of Object.entries(event.counts)) parts.push(`${count} ${field}`)
  if (event.event !== "cache") {
    if (event.errorCode) parts.push(event.errorCode)
    if (event.providerError) parts.push(event.providerError)
  }

  return `${MARK[event.event]} ${event.operation.padEnd(16)} ${parts.join("  ")}`.trimEnd()
}

const MARK = { request: "→", response: "←", cache: "•", warning: "!" } as const

const age = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`)

const size = (bytes: number): string => (bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(1)} kB`)
