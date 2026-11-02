import { formatLocator } from "../../domain/locator.js"
import type { Message } from "../../domain/models.js"
import type { StatusChat, StatusItem, StatusWho } from "./types.js"

/** The most of a message's text any status item carries. */
export const EXCERPT_CHARS = 80

export const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  const letters = Array.from(flat)
  return letters.length <= EXCERPT_CHARS ? flat : `${letters.slice(0, EXCERPT_CHARS - 1).join("")}…`
}

export const messageRef = (chat: StatusChat, message: Pick<Message, "id">): string =>
  formatLocator({
    provider: chat.account.provider,
    account: chat.account.account,
    chat: chat.chatId,
    message: message.id,
  })

export const evidenceOf = (chat: StatusChat, ...messages: Pick<Message, "id">[]): StatusItem["evidence"] =>
  messages.slice(0, 8).map((message) => ({ ref: messageRef(chat, message), fingerprint: null }))

// Person refs wait for the shared ref summaries; until then the sender's stored name is the label.
export const whoOf = (message: Pick<Message, "outgoing" | "senderName">): StatusWho => ({
  ref: null,
  name: message.outgoing === true ? null : message.senderName,
  owner: message.outgoing === true,
})

export const fromOwner = (message: Pick<Message, "outgoing">): boolean => message.outgoing === true

export const day = (at: number | string): string => new Date(at).toISOString().slice(0, 10)
