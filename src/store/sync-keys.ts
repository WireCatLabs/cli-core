import type { Id } from "../domain/models.js"

/** The sync state that marks a chat fetched back to its first message (phase 2 plan S10). */
export const historyStartKey = (chatId: Id): string => `history_start:${chatId}`

/** Set when a `messages sync` run holds the chat's newest page; its `at` is when. */
export const fetchedKey = (chatId: Id): string => `fetched:${chatId}`

/** Set when the store was handed the account's whole chat list (`markChatsLeft`); its `at` is when. */
export const CHAT_LIST_KEY = "chat_list_complete"
