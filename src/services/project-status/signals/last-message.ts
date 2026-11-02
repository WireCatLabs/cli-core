import { evidenceOf, whoOf } from "../items.js"
import type { StatusItem, StatusSignal } from "../types.js"

export type LastMessageData = Record<string, never>

/** The newest stored message in the window: when, and who wrote it. A chat held in part says so through `coverage`. */
export const lastMessage: StatusSignal<LastMessageData> = {
  id: "last-message",
  version: 1,
  scope: "chat",
  read: async (_context, chat) => {
    const last = chat?.messages.at(-1)
    if (!chat || !last) return []
    const item: StatusItem<LastMessageData> = {
      signal: "last-message",
      chat: chat.ref,
      at: last.timestamp,
      who: whoOf(last),
      evidence: evidenceOf(chat, last),
      basis: "store",
      data: {},
    }
    return [item]
  },
}
