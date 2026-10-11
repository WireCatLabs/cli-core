import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { resolvePaths } from "@wirecat/cli-base"
import type { AppIdentity } from "../cli/app.js"
import type { Id } from "../domain/models.js"
import { withFileLock } from "./file-lock.js"

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
  /** How many messages a `delete` entry named — each one counts toward the hourly limit. */
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
  attachments?: { kind: "photo" | "file" | "video" | "voice"; bytes: number }[]
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

/**
 * `<state dir>/sends/<profile>.jsonl` — beside `runs`, never in the cache directory, so that
 * clearing a cache cannot erase what was sent in the owner's name.
 */
export const sendsPathFor = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv = process.env): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "sends", `${profile}.jsonl`)

export class SendJournal {
  constructor(readonly path: string) {}

  /**
   * Runs `body` with the journal to itself, across processes: two sends at the limit must not both
   * read "one left". A lock file opened with `wx`, because `flock` is not there on Windows.
   */
  locked<T>(body: () => T): T {
    return withFileLock(this.path, "the send journal", body)
  }

  append(entry: SendEntry): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  }

  /**
   * Oldest first, each reservation folded into its outcome; one with no outcome yet is in flight,
   * or its process died. A line that does not parse is skipped: a torn last write must not block sending.
   */
  entries(): SendEntry[] {
    const lines = this.#lines()
    const settled = new Set(lines.filter((entry) => entry.outcome !== "reserved").map((entry) => entry.reservation))
    return lines
      .filter((entry) => entry.outcome !== "reserved" || !settled.has(entry.reservation))
      .map(({ reservation, ...entry }) => (entry.outcome === "reserved" ? { ...entry, reservation } : entry))
      .map(withSendId)
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
          return [JSON.parse(line) as SendEntry]
        } catch {
          return []
        }
      })
  }
}

/** max-cli wrote the send identity as a number called `cid` before it was shared; read both. */
const withSendId = (entry: SendEntry & { cid?: number }): SendEntry => {
  const { cid, ...rest } = entry
  return cid === undefined || rest.sendId !== undefined ? rest : { ...rest, sendId: String(cid) }
}
