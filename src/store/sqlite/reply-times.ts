import type { SqlValue } from "../driver.js"
import type { AccountKey } from "../types.js"
import { PEER_KIND } from "./lucene-fields.js"
import type { StoreContext } from "./open.js"
import { read } from "./transaction.js"

/** The chats a reply-time or waiting answer reads; every chat and kind listed must hold. */
export interface ChatScope {
  accounts: AccountKey[]
  chats: { account: AccountKey; chatId: string }[]
  kinds: string[]
  /** Only chats muted (true) or not muted (false) now; absent reads both. */
  muted?: boolean
  /** Inclusive bounds in ms; absent is open. */
  since?: number
  until?: number
}
export interface ReplyDelay {
  repliedAt: number
  delayMs: number
}
export interface NewestMessage {
  chatId: number
  kind: string
  sentAt: number
  mine: boolean
  text: string
  /** The message names the owner by id, or replies to one of the owner's messages. */
  addressed: boolean
  ownerUsername: string | null
  /** Muted or archived, and not marked unread: what `inbox` leaves out. */
  quiet: boolean
}

const FAR = Number.MAX_SAFE_INTEGER

/** Muted now, until the mute runs out; one bound parameter, now. */
export const MUTED_NOW = "(coalesce(c.muted,0)=1 AND (c.muted_until IS NULL OR c.muted_until>?))"

const chatsIn = (scope: ChatScope, kinds: string[], now: number) => {
  const params: SqlValue[] = [...scope.accounts.flatMap(({ provider, account }) => [provider, account]), ...kinds]
  const parts = [
    `(${scope.accounts.map(() => "(ac.provider=? AND ac.external_id=?)").join(" OR ") || "0"})`,
    `${PEER_KIND} IN (${kinds.map(() => "?").join(",")})`,
  ]
  for (const { account, chatId } of scope.chats) {
    parts.push("ac.provider=? AND ac.external_id=? AND c.external_id=?")
    params.push(account.provider, account.account, chatId)
  }
  for (const kind of scope.kinds) {
    parts.push(`${PEER_KIND}=?`)
    params.push(kind)
  }
  if (scope.muted !== undefined) {
    parts.push(scope.muted ? MUTED_NOW : `NOT ${MUTED_NOW}`)
    params.push(now)
  }
  // As in search: a chat named is read even when it is not searchable.
  if (scope.chats.length === 0) parts.push("c.searchable=1")
  return { sql: parts.join(" AND "), params }
}

/**
 * One row per reply in one-to-one chats. Each chat is read from the start of the run before the first message in the
 * period, so a reply early in the period is timed from the first message it answers, however old.
 */
export const replyDelaysQuery = (scope: ChatScope, who: "me" | "others", now: number) => {
  const since = scope.since ?? -FAR
  const until = scope.until ?? FAR
  const chats = chatsIn(scope, ["private"], now)
  return {
    sql: `WITH scoped AS MATERIALIZED (
  SELECT c.id AS chat_id, coalesce((
    SELECT p.sent_at FROM messages p WHERE p.chat_id=c.id AND p.sent_at<? AND p.deleted_at IS NULL
      AND coalesce(p.outgoing,0)<>(SELECT coalesce(l.outgoing,0) FROM messages l
        WHERE l.chat_id=c.id AND l.sent_at<? AND l.deleted_at IS NULL ORDER BY l.sent_at DESC LIMIT 1)
    ORDER BY p.sent_at DESC LIMIT 1), ?) AS since
  FROM chats c JOIN accounts ac ON ac.id=c.account_id WHERE ${chats.sql}
), sides AS (
  SELECT m.chat_id, m.id, m.sent_at, coalesce(m.outgoing,0) AS mine,
    lag(coalesce(m.outgoing,0)) OVER (PARTITION BY m.chat_id ORDER BY m.sent_at, m.id) AS before
  FROM scoped s JOIN messages m ON m.chat_id=s.chat_id AND m.sent_at>=s.since AND m.sent_at<=?
  WHERE m.deleted_at IS NULL
), runs AS (
  SELECT sent_at, mine, lag(sent_at) OVER (PARTITION BY chat_id ORDER BY sent_at, id) AS asked_at
  FROM sides WHERE before IS NULL OR before<>mine
)
SELECT sent_at AS replied_at, sent_at-asked_at AS delay_ms FROM runs
WHERE asked_at IS NOT NULL AND mine=? AND sent_at>=? AND sent_at<=?`,
    params: [since, since, -FAR, ...chats.params, until, who === "me" ? 1 : 0, since, until] as SqlValue[],
  }
}

export const replyDelays = (context: StoreContext, scope: ChatScope, who: "me" | "others"): ReplyDelay[] => {
  const { sql, params } = replyDelaysQuery(scope, who, context.now())
  return read(context.database, () =>
    context.database
      .prepare(sql)
      .all(...params)
      .map((row) => ({ repliedAt: Number(row.replied_at), delayMs: Number(row.delay_ms) })),
  )
}

/** Each one-to-one chat's and group's newest message, found by index per chat, its time within the scope's bounds. */
export const newestMessagesQuery = (scope: ChatScope, now: number) => {
  const chats = chatsIn(scope, ["private", "group"], now)
  return {
    sql: `SELECT c.id AS chat_id, ${PEER_KIND} AS kind, m.sent_at, coalesce(m.outgoing,0) AS mine, m.text,
  (EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.mentions) THEN m.mentions ELSE '[]' END) WHERE value=ac.external_id)
    OR coalesce(json_extract(CASE WHEN json_valid(m.reply_to) THEN m.reply_to ELSE '{}' END,'$.outgoing'),0)=1
    OR EXISTS (SELECT 1 FROM messages q WHERE q.chat_id=c.id AND q.external_id=m.reply_to_external_id AND q.outgoing=1)
  ) AS addressed,
  (SELECT i.username FROM identities i WHERE i.provider=ac.provider AND i.external_id=ac.external_id) AS owner_username,
  (${MUTED_NOW} OR coalesce(c.archived,0)=1)
    AND coalesce(c.marked_unread,0)=0 AS quiet
FROM chats c JOIN accounts ac ON ac.id=c.account_id
JOIN messages m ON m.id=(SELECT n.id FROM messages n WHERE n.chat_id=c.id AND n.deleted_at IS NULL ORDER BY n.sent_at DESC LIMIT 1)
WHERE ${chats.sql} AND m.sent_at>=? AND m.sent_at<=?`,
    params: [now, ...chats.params, scope.since ?? -FAR, scope.until ?? FAR] as SqlValue[],
  }
}

/** The newest `cap` messages of a chat, newest first: enough to find where the owner last spoke. */
export const TAIL_SQL =
  "SELECT sent_at, coalesce(outgoing,0) AS mine FROM messages WHERE chat_id=? AND deleted_at IS NULL ORDER BY sent_at DESC LIMIT ?"

export interface WaitingChat {
  kind: string
  /** When each of the other side's messages after the owner's last one was sent, newest first. */
  unanswered: number[]
}

/**
 * The chats whose newest message `waits` accepts, with the other side's messages since the owner last spoke, read
 * back no further than `cap` messages per chat.
 */
export const waitingChats = (
  context: StoreContext,
  scope: ChatScope,
  waits: (newest: NewestMessage) => boolean,
  cap: number,
): WaitingChat[] => {
  const { sql, params } = newestMessagesQuery(scope, context.now())
  const { database } = context
  return read(database, () => {
    const tail = database.prepare(TAIL_SQL)
    return database
      .prepare(sql)
      .all(...params)
      .map(
        (row): NewestMessage => ({
          chatId: Number(row.chat_id),
          kind: String(row.kind),
          sentAt: Number(row.sent_at),
          mine: Number(row.mine) === 1,
          text: String(row.text),
          addressed: Number(row.addressed) === 1,
          ownerUsername: row.owner_username === null ? null : String(row.owner_username),
          quiet: Number(row.quiet) === 1,
        }),
      )
      .filter(waits)
      .map(({ chatId, kind }) => {
        const unanswered: number[] = []
        for (const row of tail.all(chatId, cap)) {
          if (Number(row.mine) === 1) break
          unanswered.push(Number(row.sent_at))
        }
        return { kind, unanswered }
      })
  })
}
