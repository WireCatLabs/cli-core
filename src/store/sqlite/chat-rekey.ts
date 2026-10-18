import { CliError } from "@wirecat/cli-base"
import { formatLocator } from "../../domain/locator.js"
import type { Id } from "../../domain/models.js"
import type { AccountKey } from "../types.js"
import { purgeChats } from "./chats.js"
import { pointerPairs } from "./entity-types.js"
import { tombstone } from "./messages.js"
import type { StoreContext } from "./open.js"

export interface ChatRekey {
  outcome: "renamed" | "merged" | "unchanged"
  /** Messages that moved from the chat stored under the new id into the kept one. */
  messages: number
  /** Messages both chats held under one id; the kept chat's copy stays. */
  duplicates: number
}

const chatRow = (context: StoreContext, accountKey: number, chatId: Id) =>
  context.database.prepare("SELECT * FROM chats WHERE account_id = ? AND external_id = ?").get(accountKey, chatId)

/**
 * Re-points every `<x>_type = type` pointer from one row to another. A pointer the kept row already has (a unique
 * key) is a duplicate and goes. Involvements are derived and recomputed, so they are left for the purge.
 */
const pointerMover = (context: StoreContext, type: "chat" | "message") => {
  const statements = pointerPairs(context.database)
    .filter(({ table }) => table !== "involvements")
    .map(({ table, pointer }) => {
      const where = `WHERE ${pointer}_type = '${type}' AND ${pointer}_id = ?`
      return [
        context.database.prepare(`UPDATE OR IGNORE ${table} SET ${pointer}_id = ? ${where}`),
        context.database.prepare(`DELETE FROM ${table} ${where}`),
      ] as const
    })
  return (from: number, to: number): void => {
    for (const [move, drop] of statements) {
      move.run(to, from)
      drop.run(from)
    }
  }
}

const renameText = (context: StoreContext, key: AccountKey, accountKey: number, from: Id, to: Id): void => {
  const { database } = context
  database
    .prepare(
      "UPDATE OR REPLACE sync_cursors SET key = substr(key, 1, length(key) - length(?)) || ? WHERE account_id = ? AND key LIKE '%:' || ? AND substr(key, length(key) - length(?) + 1) = ?",
    )
    .run(from, to, accountKey, from, from, from)
  const locator = (chat: Id) => formatLocator({ provider: key.provider, account: key.account, chat, message: "" })
  const [old, renamed] = [locator(from), locator(to)]
  for (const table of ["tasks", "task_pairs"])
    database
      .prepare(
        `UPDATE ${table} SET source_locator = ? || substr(source_locator, length(?) + 1) WHERE substr(source_locator, 1, length(?)) = ?`,
      )
      .run(renamed, old, old, old)
  database
    .prepare("UPDATE tasks SET source_group = ? WHERE source_group = ? AND substr(source_locator, 1, length(?)) = ?")
    .run(to, from, renamed, renamed)
}

/** Moves what the chat stored under the new id holds into the kept one, then purges it. */
const absorb = (context: StoreContext, kept: number, gone: number): Omit<ChatRekey, "outcome"> => {
  const { database } = context
  const pairs = database
    .prepare(
      "SELECT g.id AS gone, k.id AS kept, g.deleted_at IS NOT NULL OR k.deleted_at IS NOT NULL AS deleted FROM messages g JOIN messages k ON k.chat_id = ? AND k.external_id = g.external_id WHERE g.chat_id = ?",
    )
    .all(kept, gone)
    .map((row) => ({ gone: Number(row.gone), kept: Number(row.kept), deleted: Boolean(row.deleted) }))
  const moveMessagePointers = pointerMover(context, "message")
  const threads = database.prepare("UPDATE messages SET thread_root_id = ? WHERE thread_root_id = ?")
  const links = ["message_id", "parent_id"].map((column) =>
    database.prepare(`UPDATE OR IGNORE message_links SET ${column} = ? WHERE ${column} = ?`),
  )
  for (const pair of pairs) {
    threads.run(pair.kept, pair.gone)
    // A copy deleted at the source must not come back through its twin: nothing of the other copy moves onto it.
    if (pair.deleted) {
      tombstone(context, pair.kept)
      continue
    }
    for (const link of links) link.run(pair.kept, pair.gone)
    moveMessagePointers(pair.gone, pair.kept)
  }
  const moved = database
    .prepare(
      "UPDATE messages SET chat_id = ? WHERE chat_id = ? AND external_id NOT IN (SELECT external_id FROM messages WHERE chat_id = ?)",
    )
    .run(kept, gone, kept).changes
  database.prepare("UPDATE OR IGNORE message_links SET chat_id = ? WHERE chat_id = ? AND build IS NULL").run(kept, gone)
  database
    .prepare(
      "DELETE FROM poll_votes WHERE chat_id = ? AND EXISTS (SELECT 1 FROM poll_votes g WHERE g.chat_id = ? AND g.message_external_id = poll_votes.message_external_id AND g.identity_id = poll_votes.identity_id AND g.voted_at > poll_votes.voted_at)",
    )
    .run(kept, gone)
  for (const table of [
    "poll_votes",
    "message_transcripts",
    "chat_members",
    "member_stays",
    "member_counts",
    "member_observations",
    "auto_tag_claims",
  ])
    database.prepare(`UPDATE OR IGNORE ${table} SET chat_id = ? WHERE chat_id = ?`).run(kept, gone)
  database
    .prepare(
      "UPDATE message_transcripts SET message_id = (SELECT id FROM messages m WHERE m.chat_id = message_transcripts.chat_id AND m.external_id = message_transcripts.message_external_id) WHERE chat_id = ?",
    )
    .run(kept)
  database
    .prepare(
      "DELETE FROM message_transcripts WHERE chat_id = ? AND message_id IN (SELECT id FROM messages WHERE chat_id = ? AND deleted_at IS NOT NULL)",
    )
    .run(kept, kept)
  database.prepare("UPDATE chats SET parent_chat_id = ? WHERE parent_chat_id = ?").run(kept, gone)
  pointerMover(context, "chat")(gone, kept)
  purgeChats(context, [gone])
  database
    .prepare(
      "UPDATE chats SET message_count = (SELECT count(*) FROM messages WHERE chat_id = ? AND deleted_at IS NULL) WHERE id = ?",
    )
    .run(kept, kept)
  return { messages: moved, duplicates: pairs.length }
}

const scalar = (value: unknown): string | number | null =>
  typeof value === "string" || typeof value === "number" ? value : null

const time = (value: unknown): number | null => (typeof value === "number" ? value : null)

const latest = (a: unknown, b: unknown): number | null => {
  const [one, other] = [time(a), time(b)]
  return one === null ? other : other === null ? one : Math.max(one, other)
}

const MESSENGER_FIELDS = [
  "title",
  "unread_count",
  "participants_count",
  "metadata",
  "username",
  "membership_state",
  "description",
  "details_fetched_at",
] as const

/**
 * A chat the messenger now names by another id: renamed in place, or merged into the row already stored under the
 * new id's twin. Replaying it, or naming a chat the store does not hold, changes nothing. Runs inside `write`.
 */
export const rekeyChat = (context: StoreContext, key: AccountKey, accountKey: number, from: Id, to: Id): ChatRekey => {
  const old = from === to ? undefined : chatRow(context, accountKey, from)
  if (!old) return { outcome: "unchanged", messages: 0, duplicates: 0 }
  const twin = chatRow(context, accountKey, to)
  const kept = Number(old.id)
  let moved = { messages: 0, duplicates: 0 }
  if (twin) {
    if (old.kind !== twin.kind && old.kind !== "unknown" && twin.kind !== "unknown")
      throw new CliError("validation_error", `a ${String(old.kind)} and a ${String(twin.kind)} are not one chat`)
    moved = absorb(context, kept, Number(twin.id))
    const fields = MESSENGER_FIELDS.map((field) => `${field} = coalesce(?, ${field})`).join(", ")
    context.database
      .prepare(
        `UPDATE chats SET ${fields}, kind = CASE WHEN kind = 'unknown' THEN ? ELSE kind END, last_message_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        ...MESSENGER_FIELDS.map((field) => scalar(twin[field])),
        scalar(twin.kind),
        latest(old.last_message_at, twin.last_message_at),
        context.now(),
        kept,
      )
  }
  context.database.prepare("UPDATE chats SET external_id = ?, updated_at = ? WHERE id = ?").run(to, context.now(), kept)
  renameText(context, key, accountKey, from, to)
  return { outcome: twin ? "merged" : "renamed", ...moved }
}
