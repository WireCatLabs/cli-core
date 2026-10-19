import { CliError } from "@wirecat/cli-base"
import { formatLocator } from "../../domain/locator.js"
import type { Id } from "../../domain/models.js"
import type { AccountKey } from "../types.js"
import { purgeChats } from "./chats.js"
import { pointerPairs } from "./entity-types.js"
import { tombstone } from "./messages.js"
import { targetKey } from "./notes.js"
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
  const relink = database.prepare("UPDATE links SET target_text = ?, target_folded = ? WHERE id = ?")
  for (const row of database
    .prepare("SELECT id, target_text FROM links WHERE to_id IS NULL AND substr(target_text, 1, length(?)) = ?")
    .all(old, old)) {
    const text = renamed + String(row.target_text).slice(old.length)
    relink.run(text, targetKey(text), Number(row.id))
  }
}

/**
 * A person may have one open stay per chat, so an open stay in both chats becomes one. Left behind, the absorbed one
 * would be purged with the observations that moved still pointing at it, and the foreign key refuses the re-key.
 */
const foldOpenStays = (context: StoreContext, kept: number, gone: number): void => {
  const { database } = context
  const pairs = database
    .prepare(
      "SELECT g.id AS gone, k.id AS kept FROM member_stays g JOIN member_stays k ON k.chat_id = ? AND k.identity_id = g.identity_id AND k.left_at IS NULL WHERE g.chat_id = ? AND g.left_at IS NULL",
    )
    .all(kept, gone)
  const fold = database.prepare(
    `UPDATE member_stays SET
       first_seen_at = min(member_stays.first_seen_at, g.first_seen_at),
       last_seen_at = max(member_stays.last_seen_at, g.last_seen_at),
       joined_at = coalesce(min(member_stays.joined_at, g.joined_at), member_stays.joined_at, g.joined_at),
       role = CASE WHEN g.last_seen_at > member_stays.last_seen_at THEN coalesce(g.role, member_stays.role)
         ELSE coalesce(member_stays.role, g.role) END,
       invited_by_identity_id = coalesce(member_stays.invited_by_identity_id, g.invited_by_identity_id),
       updated_at = ?
     FROM (SELECT * FROM member_stays WHERE id = ?) AS g WHERE member_stays.id = ?`,
  )
  const observed = database.prepare("UPDATE member_observation_members SET member_stay_id = ? WHERE member_stay_id = ?")
  const drop = database.prepare("DELETE FROM member_stays WHERE id = ?")
  for (const pair of pairs) {
    fold.run(context.now(), Number(pair.gone), Number(pair.kept))
    observed.run(Number(pair.kept), Number(pair.gone))
    drop.run(Number(pair.gone))
  }
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
  // Without a time on either star, the kept copy's word stands and the absorbed one only fills a gap.
  const star = database.prepare(
    "UPDATE messages SET starred = (SELECT starred FROM messages WHERE id = ?) WHERE id = ? AND starred IS NULL",
  )
  const links = ["message_id", "parent_id"].map((column) =>
    database.prepare(`UPDATE OR IGNORE message_links SET ${column} = ? WHERE ${column} = ?`),
  )
  for (const pair of pairs) {
    threads.run(pair.kept, pair.gone)
    star.run(pair.gone, pair.kept)
    // Both copies become tombstones before anything moves, so only what a deletion keeps (the owner's links) moves.
    if (pair.deleted) {
      tombstone(context, pair.gone)
      tombstone(context, pair.kept)
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
  // The absorbed copy of an event both chats hold is purged, so the people only it named move first.
  database
    .prepare(
      "INSERT OR IGNORE INTO chat_event_people (chat_event_id, identity_id) SELECT k.id, p.identity_id FROM chat_events g JOIN chat_events k ON k.chat_id = ? AND k.source_id = g.source_id JOIN chat_event_people p ON p.chat_event_id = g.id WHERE g.chat_id = ?",
    )
    .run(kept, gone)
  foldOpenStays(context, kept, gone)
  for (const table of [
    "poll_votes",
    "chat_events",
    "message_transcripts",
    "chat_members",
    "member_stays",
    "member_counts",
    "member_observations",
    "auto_tag_claims",
  ])
    database.prepare(`UPDATE OR IGNORE ${table} SET chat_id = ? WHERE chat_id = ?`).run(kept, gone)
  // Moved members fire no insert trigger, so the chat's involvements are queued by hand.
  database.prepare("INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('chat', ?)").run(kept)
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

type Row = NonNullable<ReturnType<typeof chatRow>>

/**
 * The owner's word on a chat must not loosen because a stray twin merged in: hidden wins, and when the two chats sit
 * on different sides of the owner's life, the personal side wins, since a work chat reaches work views and meeting
 * preparation a personal one does not. A scope either half pinned stays pinned, so a later change to the account's
 * default cannot loosen the merged chat.
 */
const strictest = (context: StoreContext, accountKey: number, old: Row, twin: Row) => {
  const account = context.database.prepare("SELECT scope FROM accounts WHERE id = ?").get(accountKey)
  const effective = (row: Row) => scalar(row.scope) ?? scalar(account?.scope)
  return {
    searchable: Math.min(Number(old.searchable), Number(twin.searchable)),
    scope:
      scalar(old.scope) === null && scalar(twin.scope) === null
        ? null
        : effective(old) === effective(twin)
          ? effective(old)
          : "personal",
  }
}

const MESSENGER_FIELDS = [
  "title",
  "unread_count",
  "participants_count",
  "metadata",
  "username",
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
    const strict = strictest(context, accountKey, old, twin)
    moved = absorb(context, kept, Number(twin.id))
    const fields = MESSENGER_FIELDS.map((field) => `${field} = coalesce(?, ${field})`).join(", ")
    context.database
      .prepare(
        // Left only when both were: a complete chat list that named the new id before the re-key marked the old one.
        `UPDATE chats SET ${fields}, kind = CASE WHEN kind = 'unknown' THEN ? ELSE kind END,
           membership_state = CASE WHEN ? IS NULL THEN nullif(membership_state, 'left') ELSE coalesce(nullif(?, 'left'), membership_state) END,
           searchable = ?, scope = ?, last_message_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        ...MESSENGER_FIELDS.map((field) => scalar(twin[field])),
        scalar(twin.kind),
        scalar(twin.membership_state),
        scalar(twin.membership_state),
        strict.searchable,
        strict.scope,
        latest(old.last_message_at, twin.last_message_at),
        context.now(),
        kept,
      )
  }
  context.database.prepare("UPDATE chats SET external_id = ?, updated_at = ? WHERE id = ?").run(to, context.now(), kept)
  renameText(context, key, accountKey, from, to)
  return { outcome: twin ? "merged" : "renamed", ...moved }
}
