import type { Id } from "../domain/models.js"
import type { AccountKey, ChatCompleteness, MessageStore } from "../store/store.js"

/** What the store holds of one chat, and how far that goes: never message text. */
export interface ChatCoverage {
  chatId: Id
  /** The chat row's title; `null` when the store has no row for the chat or the row has none. */
  title: string | null
  completeness: ChatCompleteness
  held: { messages: number; oldestAt: string | null; newestAt: string | null }
}

/**
 * Per chat, in the order asked: `chatCompleteness` with the span `chatStats` holds. Stats are read one chat at a time,
 * because the account-wide read groups every message of every chat. A chat the store has no row for is `unknown`.
 */
export const chatCoverage = async (
  store: Pick<MessageStore, "chats">,
  account: AccountKey,
  chatIds: Id[],
): Promise<ChatCoverage[]> => {
  const ids = [...new Set(chatIds)]
  if (ids.length === 0) return []
  const found = new Map((await store.chats.chatCompleteness(account, ids)).map((one) => [one.chatId, one]))
  return Promise.all(
    ids.map(async (chatId) => {
      const [stats] = await store.chats.chatStats(account, chatId)
      const title = stats?.title ?? (await store.chats.chatTitle(account, chatId))
      const completeness = found.get(chatId) ?? {
        chatId,
        state: "unknown" as const,
        upToDate: null,
        gaps: false,
        reachesStart: false,
        fetchedAt: null,
      }
      return {
        chatId,
        title,
        completeness,
        held: { messages: stats?.messages ?? 0, oldestAt: stats?.oldestAt ?? null, newestAt: stats?.newestAt ?? null },
      }
    }),
  )
}
