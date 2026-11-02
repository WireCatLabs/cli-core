import type { Id } from "../../domain/models.js"
import type { ChatShape, HistorySkip } from "../../services/history-limits.js"
import type { StoreContext } from "./open.js"

/**
 * The history limits' record of a chat, kept in the chat row's `metadata` under this key so no store version is
 * needed; `Chat.providerMetadata` leaves it out.
 */
export const HISTORY_KEY = "$history"

interface HistoryRecord {
  skipped?: HistorySkip
  included?: boolean
}

export interface ChatHistoryShape extends ChatShape {
  included: boolean
}

export interface StoredHistorySkip extends HistorySkip {
  chatId: Id
  title: string | null
}

const objectOf = (text: unknown): Record<string, unknown> => {
  if (typeof text !== "string") return {}
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const recordOf = (metadata: unknown): HistoryRecord => {
  const value = objectOf(metadata)[HISTORY_KEY]
  return value !== null && typeof value === "object" ? (value as HistoryRecord) : {}
}

const rowOf = ({ database }: StoreContext, accountKey: number, chatId: Id) =>
  database
    .prepare("SELECT id, kind, participants_count, metadata FROM chats WHERE account_id = ? AND external_id = ?")
    .get(accountKey, chatId)

const update = (
  context: StoreContext,
  id: number,
  metadata: unknown,
  change: (held: HistoryRecord) => HistoryRecord,
) => {
  const all = objectOf(metadata)
  const next = change(recordOf(metadata))
  if (next.skipped === undefined && !next.included) delete all[HISTORY_KEY]
  else all[HISTORY_KEY] = next
  const text = Object.keys(all).length === 0 ? null : JSON.stringify(all)
  context.database.prepare("UPDATE chats SET metadata = ?, updated_at = ? WHERE id = ?").run(text, context.now(), id)
}

export const historyShapes = (context: StoreContext, accountKey: number, chatIds: Id[]): Map<Id, ChatHistoryShape> => {
  const shapes = new Map<Id, ChatHistoryShape>()
  for (const chatId of new Set(chatIds)) {
    const row = rowOf(context, accountKey, chatId)
    if (!row) continue
    shapes.set(chatId, {
      kind: String(row.kind),
      participantsCount: row.participants_count == null ? null : Number(row.participants_count),
      included: recordOf(row.metadata).included === true,
    })
  }
  return shapes
}

/** Adds what one push left out to what the chat's record already holds. A chat the store lacks is left as it is. */
export const recordHistorySkips = (context: StoreContext, accountKey: number, skips: Map<Id, HistorySkip>): void => {
  for (const [chatId, skip] of skips) {
    const row = rowOf(context, accountKey, chatId)
    if (!row) continue
    update(context, Number(row.id), row.metadata, (held) => {
      const before = held.skipped
      const skipped: HistorySkip = before
        ? {
            ...skip,
            messages: before.messages + skip.messages,
            oldestAt: before.oldestAt < skip.oldestAt ? before.oldestAt : skip.oldestAt,
            newestAt: before.newestAt > skip.newestAt ? before.newestAt : skip.newestAt,
          }
        : skip
      return { ...held, skipped }
    })
  }
}

/** Lifts the limits for one chat from now on, or puts them back. Answers `false` for a chat the store lacks. */
export const setHistoryIncluded = (
  context: StoreContext,
  accountKey: number,
  chatId: Id,
  included: boolean,
): boolean => {
  const row = rowOf(context, accountKey, chatId)
  if (!row) return false
  update(context, Number(row.id), row.metadata, (held) => ({ ...held, included }))
  return true
}

/** Every chat of the account whose pushed history the limits left out, most messages first. */
export const historySkips = ({ database }: StoreContext, accountKey: number): StoredHistorySkip[] =>
  database
    .prepare(
      `SELECT external_id, title, metadata FROM chats WHERE account_id = ? AND metadata LIKE '%"${HISTORY_KEY}"%'`,
    )
    .all(accountKey)
    .flatMap((row) => {
      const { skipped } = recordOf(row.metadata)
      return skipped
        ? [{ chatId: String(row.external_id), title: row.title == null ? null : String(row.title), ...skipped }]
        : []
    })
    .sort((a, b) => b.messages - a.messages)

/** `metadata` as the messenger gave it: the history record is the store's own. */
export const withoutHistory = <T extends Record<string, unknown> | undefined>(metadata: T): T => {
  if (metadata === undefined || !(HISTORY_KEY in metadata)) return metadata
  const { [HISTORY_KEY]: _, ...rest } = metadata
  return rest as T
}
