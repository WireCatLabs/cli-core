import { readFileSync } from "node:fs"
import type { Chat, Message } from "../domain/models.js"
import type { AccountKey, MessageStore } from "../store/store.js"

export interface SearchRecipes {
  chats: Pick<Chat, "id" | "title" | "kind">[]
  messages: Pick<Message, "id" | "chatId" | "text" | "timestamp" | "senderId" | "senderName">[]
  tags: (
    | { type: "chat"; chat: string; tag: string }
    | { type: "contact"; person: string; tag: string }
    | { type: "message"; chat: string; message: string; tag: string }
  )[]
  /** Text of a file, as `attachments extract` would keep it; `attachment` counts from 1. */
  fileTexts: { chat: string; message: string; attachment: number; text: string }[]
  recipes: { title: string; query: string; ids: string[] }[]
  negative: { query: string; code: string; reason: string }[]
}
export const searchRecipes: SearchRecipes = JSON.parse(
  readFileSync(new URL("../../docs/search/recipes.json", import.meta.url), "utf8"),
)
export const seedSearchRecipes = async (store: MessageStore, account: AccountKey): Promise<void> => {
  await store.chats.saveChats(
    account,
    searchRecipes.chats.map((chat) => ({ ...chat, unreadCount: 0, lastMessageAt: null, participantsCount: null })),
  )
  for (const { id } of searchRecipes.chats) {
    await store.messages.saveMessages(
      account,
      id,
      searchRecipes.messages
        .filter(({ chatId }) => chatId === id)
        .map((row) => ({
          editedAt: null,
          outgoing: false,
          attachments: [],
          replyTo: null,
          forwardedFrom: null,
          reactions: null,
          ...row,
        })),
      { via: "history" },
    )
  }
  for (const one of searchRecipes.tags) {
    const target =
      one.type === "chat"
        ? { type: one.type, chatId: one.chat }
        : one.type === "contact"
          ? { type: one.type, personId: one.person }
          : { type: one.type, chatId: one.chat, messageId: one.message }
    await store.tags.addTags(account, target, [one.tag])
  }
  const files = await store.attachments.fileAttachments(account, { limit: 1000 })
  for (const one of searchRecipes.fileTexts) {
    const file = files.find(
      ({ chatId, messageId, position }) =>
        chatId === one.chat && messageId === one.message && position === one.attachment - 1,
    )
    if (file)
      await store.attachments.keepAttachmentText(file.pk, { text: one.text, origin: "extracted", extractor: "plain" })
  }
}
