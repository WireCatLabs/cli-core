import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { logRecordOf, resolvePaths } from "@wirecat/cli-base"
import type { LogRecord } from "@wirecat/cli-base/standards"
import type { Id } from "../domain/models.js"
import type { AppIdentity } from "../ports/app.js"
import { LOG_ATTRIBUTES } from "../runs/log-attributes.js"
import { fromLogAttributes, logAttributes } from "../runs/log-keys.js"
import { currentRun } from "../runs/scope.js"
import { withFileLock, withFileLockAsync } from "./file-lock.js"

/** `reserved` holds a place under the hourly limit while the write is on its way; its outcome follows. */
export type SendOutcome = "sent" | "outcome_unknown" | "refused" | "failed" | "reserved"

/** Absent in the journal means a message: that is every line written before reactions were guarded. */
export type SendKind = "message" | "reaction" | "edit" | "forward" | "pin" | "read" | "delete" | "chat" | "account"

/** What a `chat` entry did. Never a title, a description or a link — only which action. */
export type ChatAction =
  | "create"
  | "join"
  | "leave"
  | "delete"
  | "clear"
  | "members.add"
  | "members.remove"
  | "admins.add"
  | "admins.remove"
  | "update"
  | "settings"
  | "requests.accept"
  | "requests.decline"
  | "link.reset"
  | "link.create"
  | "link.revoke"
  | "link.update"
  | "forum-upgrade"
  | "forum-enable"
  | "topic-create"
  | "topic-edit"
  | "topic-delete"
  | "topic-close"
  | "topic-reopen"
  | "topic-pin"
  | "topic-unpin"
  | "topic-order"
  | "topic-hide"
  | "topic-unhide"

/** What an `account` entry changed. Never the value it changed it to — no name, number or title. */
export type AccountAction =
  | "contact-add"
  | "contact-remove"
  | "contact-import"
  | "contact-rename"
  | "contact-block"
  | "contact-unblock"
  | "profile"
  | "folder-create"
  | "folder-update"
  | "folder-delete"
  | "folder-order"
  | "folder-join"
  | "sessions-end"
  | "chat-mute"
  | "chat-unmute"
  | "chat-archive"
  | "chat-unarchive"
  | "chat-pin"
  | "chat-unpin"
  | "chat-mark-unread"
  | "message-star"
  | "message-unstar"
  | "message-flag"
  | "message-move"
  | "message-copy"
  | "message-delete"
  | "message-restore"
  | "privacy"

/** One attempt to send. **Never the text** — only its length. */
export interface SendEntry {
  at: string
  profile: string
  /** `null` when a join or a creation was refused before there was a chat, and for a change to the account itself. */
  chatId: Id | null
  outcome: SendOutcome
  kind?: SendKind
  action?: ChatAction | AccountAction
  /** How many people a `chat` entry added or removed. */
  people?: number
  messageId?: Id
  /** The command a write belongs to, where it named one: `polls.create` sets a poll apart from a message. */
  key?: string
  /** How many messages a `delete` entry named, or an album sent — each one counts toward the hourly limit. */
  count?: number
  forEveryone?: boolean
  /**
   * The client-side identity of one logical send — Telegram's `random_id`, MAX's `cid` — as a
   * string: Telegram's is 64-bit. A retry repeats it, and the provider delivers one message for both.
   */
  sendId?: string
  /**
   * One write's id — in its answer, on each of its lines here and in its run events. A send's is its
   * `sendId`. Absent on lines written before writes had one.
   */
  operationId?: string
  parentOperationId?: string
  /** The message a reply answers. */
  replyTo?: Id
  threadId?: Id
  /** The identity a message was sent as, when not the account itself by default. */
  sendAs?: Id
  resultChatId?: Id
  length?: number
  /** What was attached, by kind and size — never a file name. */
  attachments?: { kind: "photo" | "file" | "video" | "voice" | "sticker"; bytes: number }[]
  /** When the provider will send it; it counts toward the limit of that hour, not of the hour it was queued. */
  scheduledFor?: string
  /** Whether a pin told the members. */
  notify?: boolean
  /** What sent it when no command did: `rule:<id>` for an auto-reply. */
  origin?: string
  /** Pairs an outcome with the `reserved` line it settles. */
  reservation?: string
  errorCode?: string
}

export interface SendFilter {
  outcome?: SendOutcome
  chatId?: Id
  operationId?: string
  errorCode?: string
  key?: string
}

/**
 * `<state dir>/sends/<profile>.jsonl` — beside `runs`, never in the cache directory, so that
 * clearing a cache cannot erase what was sent in the owner's name.
 */
export const sendsPathFor = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv = process.env): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "sends", `${profile}.jsonl`)

/**
 * One log record per line (cli-base's `LogRecord`): the entry's `at` is the record's `time`, the rest
 * its `attributes`, and the run that wrote it its `runId`. A refusal or a failure is a `warn`.
 */
export class SendJournal {
  constructor(
    readonly path: string,
    /** Who writes: the program's name and version. Only a reader may leave it out. */
    private readonly resource: LogRecord["resource"] = { service: "unknown", version: "unknown" },
  ) {}

  /**
   * Runs `body` with the journal to itself, across processes: two sends at the limit must not both
   * read "one left". A lock file opened with `wx`, because `flock` is not there on Windows.
   */
  locked<T>(body: () => T): T {
    return withFileLock(this.path, "the send journal", body)
  }

  /** `locked` without blocking the thread while another process holds the journal: what `serve` uses. */
  lockedAsync<T>(body: () => T): Promise<T> {
    return withFileLockAsync(this.path, "the send journal", body)
  }

  append(entry: SendEntry): void {
    const { at, ...attributes } = entry
    const { runId, command, traceId } = currentRun()
    const record = logRecordOf({
      severity: entry.outcome === "sent" || entry.outcome === "reserved" ? "info" : "warn",
      event: logAttributes({ event: "send.recorded", ...attributes }),
      time: at,
      runId,
      ...(traceId === undefined ? {} : { traceId }),
      command,
      resource: this.resource,
      allow: LOG_ATTRIBUTES,
    })
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  }

  /**
   * Oldest first, each reservation folded into its outcome; one with no outcome yet is in flight,
   * or its process died. A line that does not parse is skipped: a torn last write must not block sending.
   */
  entries(filter?: SendFilter): SendEntry[] {
    const lines = this.#lines()
    const settled = new Set(lines.filter((entry) => entry.outcome !== "reserved").map((entry) => entry.reservation))
    const entries = lines
      .filter((entry) => entry.outcome !== "reserved" || !settled.has(entry.reservation))
      .map(({ reservation, ...entry }) => (entry.outcome === "reserved" ? { ...entry, reservation } : entry))
      .map(withSendId)
    return filter === undefined
      ? entries
      : entries.filter(
          (entry) =>
            (filter.outcome === undefined || entry.outcome === filter.outcome) &&
            (filter.chatId === undefined || entry.chatId === filter.chatId) &&
            (filter.operationId === undefined || entry.operationId === filter.operationId) &&
            (filter.errorCode === undefined || entry.errorCode === filter.errorCode) &&
            (filter.key === undefined || entry.key === filter.key),
        )
  }

  #lines(): SendEntry[] {
    let text: string
    try {
      text = readFileSync(this.path, "utf8")
    } catch {
      return []
    }
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [entryOf(JSON.parse(line) as SendEntry | LogRecord)]
        } catch {
          return []
        }
      })
  }
}

/**
 * The guard counts every line toward the hourly limit, so a line written before the journal held
 * records — flat, with `at` — still counts.
 */
const entryOf = (line: SendEntry | LogRecord): SendEntry => {
  if (!("attributes" in line)) return line
  const { event: _, ...attributes } = line.attributes
  return { at: line.time, ...fromLogAttributes(attributes) } as SendEntry
}

/** max-cli wrote the send identity as a number called `cid` before it was shared; read both. */
const withSendId = (entry: SendEntry & { cid?: number }): SendEntry => {
  const { cid, ...rest } = entry
  return cid === undefined || rest.sendId !== undefined ? rest : { ...rest, sendId: String(cid) }
}
