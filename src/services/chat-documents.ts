import { googleDocumentLinks } from "../domain/google-documents.js"
import { formatLocator, parseLocator } from "../domain/locator.js"
import type { Id, Page } from "../domain/models.js"
import { accountStore, type ServiceDeps } from "./deps.js"
import { chatIdIn } from "./message-resolution.js"

/** One Google document link in a stored message, as `chats documents list` answers it. */
export interface ChatDocument {
  url: string
  documentId: string | null
  title: string | null
  inStore: boolean
  locator: string
  sentAt: string
  sender: { id: Id | null; name: string | null }
}

export interface ChatDocuments extends Page<ChatDocument> {
  chatId: Id
  /** The store holds no message of the chat at all: nothing was fetched, not "no links". */
  empty: boolean
}

export interface ChatDocumentsService {
  /** Reads the local store only; never asks the messenger. `limit` absent is every item. */
  list(chat: string, window: { limit?: number; offset: number; ref?: string }): Promise<ChatDocuments>
}

export const chatDocumentsService = (deps: ServiceDeps): ChatDocumentsService => ({
  list: async (chat, { limit, offset, ref }) => {
    const store = await accountStore(deps)
    const chatId = await chatIdIn(deps.messenger, chat, store, { includeLeft: true })
    const target = ref === undefined ? undefined : parseLocator(ref)
    const sameScope =
      target === undefined ||
      (target.provider === store.account.provider && target.account === store.account.account && target.chat === chatId)
    const messages = sameScope
      ? await store.messages.documentLinkMessages(chatId, target ? { messageId: target.message } : {})
      : []
    const items = messages.flatMap((message) =>
      googleDocumentLinks(message.text).map(({ url, documentId }): ChatDocument => {
        const stored = documentId === null ? undefined : message.documents.find((one) => one.fileId === documentId)
        return {
          url,
          documentId,
          title: stored?.title ?? null,
          inStore: stored !== undefined,
          locator: formatLocator({ ...store.account, chat: chatId, message: message.messageId }),
          sentAt: message.sentAt,
          sender: { id: message.senderId, name: message.senderName },
        }
      }),
    )
    const end = limit === undefined ? items.length : offset + limit
    return {
      chatId,
      items: items.slice(offset, end),
      hasMore: items.length > end,
      empty: items.length === 0 && (await store.messages.countMessages(chatId)) === 0,
    }
  },
})
