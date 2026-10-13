import type { Id } from "../../domain/models.js"
import type { StoreContext } from "./open.js"
import { toIso } from "./values.js"

/** The sync state that marks a chat fetched back to its first message (phase 2 plan S10). */
export const historyStartKey = (chatId: Id): string => `history_start:${chatId}`
/** Set when a `messages sync` run holds the chat's newest page; its `at` is when. */
export const fetchedKey = (chatId: Id): string => `fetched:${chatId}`
/** Set when the store was handed the account's whole chat list (`markChatsLeft`); its `at` is when. */
export const CHAT_LIST_KEY = "chat_list_complete"

export interface ChatCompleteness {
  chatId: Id
  /** `unknown` when nothing ever fetched the chat's history: an empty answer then proves nothing. */
  state: "complete" | "partial" | "unknown"
  /** Holds the newest message the chat list knows of; `null` when the list gave no time. */
  upToDate: boolean | null
  /** More than one stretch held, with history missing between them. */
  gaps: boolean
  reachesStart: boolean
  /** When a `messages sync` last read the chat's newest page; `null` when none has. */
  fetchedAt: string | null
}

/**
 * Three facts per chat (NEED-455 A): the newest held against the chat list's, the stretches, and the start reached.
 * A start mark that a later fetch reached past was wrong, so it stops counting.
 */
export const chatCompleteness = ({ database }: StoreContext, accountKey: number, chatIds: Id[]): ChatCompleteness[] => {
  if (chatIds.length === 0) return []
  return database
    .prepare(
      `SELECT c.external_id AS chat, c.last_message_at AS newest,
         (SELECT max(m.sent_at) FROM messages m WHERE m.chat_id = c.id AND m.deleted_at IS NULL) AS held,
         (SELECT count(*) FROM sync_ranges r WHERE r.chat_id = c.id) AS stretches,
         EXISTS (SELECT 1 FROM sync_cursors s WHERE s.account_id = c.account_id AND s.key = 'history_start:' || c.external_id
           AND NOT EXISTS (SELECT 1 FROM sync_ranges r WHERE r.chat_id = c.id AND r.from_key < CAST(s.value AS INTEGER)))
           AS start,
         (SELECT s.updated_at FROM sync_cursors s WHERE s.account_id = c.account_id AND s.key = 'fetched:' || c.external_id)
           AS fetched
       FROM chats c WHERE c.account_id = ? AND c.external_id IN (SELECT value FROM json_each(?))`,
    )
    .all(accountKey, JSON.stringify(chatIds))
    .map((row): ChatCompleteness => {
      const stretches = Number(row.stretches)
      const reachesStart = Number(row.start) === 1
      const upToDate = row.newest === null ? null : row.held !== null && Number(row.held) >= Number(row.newest)
      const gaps = stretches > 1
      const fetched = stretches > 0 || reachesStart
      return {
        chatId: String(row.chat),
        state: !fetched ? "unknown" : upToDate !== false && !gaps && reachesStart ? "complete" : "partial",
        upToDate,
        gaps,
        reachesStart,
        fetchedAt: toIso(row.fetched),
      }
    })
}
