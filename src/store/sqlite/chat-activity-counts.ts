import type { StoreContext } from "./open.js"
import { toIso } from "./values.js"

export interface ChatActivityCount {
  /** A dialog has no title: it takes the name its other side last wrote under. */
  title: string | null
  /** Muted now, until the mute runs out, as the query field `muted:` reads it. */
  muted: boolean
  /** Live messages sent in the window, `until` exclusive. */
  messages: number
  /** Of them, the owner's. */
  sent: number
  /** The newest live message the store holds of the chat, in or before the window. */
  lastAt: string | null
}

const SQL =
  "SELECT coalesce(c.title, (SELECT sender_name FROM messages WHERE chat_id = c.id AND outgoing = 0 AND " +
  "deleted_at IS NULL ORDER BY sent_at DESC LIMIT 1)) AS title, " +
  "(coalesce(c.muted, 0) = 1 AND (c.muted_until IS NULL OR c.muted_until > ?)) AS muted, " +
  "(SELECT count(*) FROM messages WHERE chat_id = c.id AND deleted_at IS NULL AND sent_at >= ? AND sent_at < ?) AS messages, " +
  "(SELECT count(*) FROM messages WHERE chat_id = c.id AND deleted_at IS NULL AND sent_at >= ? AND sent_at < ? " +
  "AND outgoing = 1) AS sent, " +
  "(SELECT max(sent_at) FROM messages WHERE chat_id = c.id AND deleted_at IS NULL AND sent_at < ?) AS last " +
  "FROM chats c WHERE c.id = ?"

/** One indexed read per chat (`messages_by_time`), so a project with a busy chat costs that chat, not the store. */
export const chatActivityCounts = (
  { database }: StoreContext,
  chatKeys: readonly number[],
  { since, until, now }: { since: number; until: number; now: number },
): Map<number, ChatActivityCount> => {
  const statement = database.prepare(SQL)
  const found = new Map<number, ChatActivityCount>()
  for (const key of new Set(chatKeys)) {
    const row = statement.get(now, since, until, since, until, until, key)
    if (!row) continue
    found.set(key, {
      title: typeof row.title === "string" && row.title.trim() !== "" ? row.title : null,
      muted: Number(row.muted) === 1,
      messages: Number(row.messages),
      sent: Number(row.sent),
      lastAt: row.last == null ? null : (toIso(Number(row.last)) ?? null),
    })
  }
  return found
}
