import type { DownloadedFile, RefreshedFile } from "../domain/attachments.js"
import type { Id } from "../domain/models.js"
import { keysOver } from "./keys.js"
import type { AttachmentTextEntry, AttachmentView, FileAttachment } from "./sqlite/attachment-texts.js"
import * as attachmentTexts from "./sqlite/attachment-texts.js"
import * as attachmentRows from "./sqlite/attachments.js"
import type { StoreContext } from "./sqlite/open.js"
import type { Where } from "./sqlite/query-filter.js"
import { write } from "./sqlite/transaction.js"
import type { AccountKey } from "./types.js"

export interface AccountAttachments {
  /**
   * Where `messages download` saved a held message's files, for reading them later. Answers how many
   * attachments it recorded: a file it cannot tell apart from another is not recorded.
   */
  keepDownloads(key: AccountKey, chatId: Id, messageId: Id, files: readonly DownloadedFile[]): Promise<number>
  /**
   * The new reference the messenger gave for files read without saving them (a voice message heard, a photo looked
   * at), matched as `keepDownloads` matches. Answers how many attachments it placed.
   */
  keepProviderRefs(key: AccountKey, chatId: Id, messageId: Id, files: readonly RefreshedFile[]): Promise<number>
  /** File attachments of this account's live messages, newest first, below `beforePk`; never one an agent wrote. */
  fileAttachments(
    key: AccountKey,
    page: { chatId?: Id; messageId?: Id; beforePk?: number; limit: number },
  ): Promise<FileAttachment[]>
  /**
   * File attachments of live messages and what is held of their text, newest first; never the text. `where` is a
   * list query compiled over `attachmentColumns`.
   */
  attachments(
    key: AccountKey,
    filter: { chatId?: Id; messageId?: Id; where?: Where; offset?: number; limit: number },
  ): Promise<AttachmentView[]>
}

export interface AttachmentsStore extends AccountAttachments {
  /** Where the file of one attachment was saved, when that is recorded. */
  localPathOf(attachmentPk: number): Promise<string | null>
  /** An extraction never replaces an agent's text; answers whether it was kept. */
  keepAttachmentText(attachmentPk: number, entry: AttachmentTextEntry): Promise<boolean>
}

export const accountAttachmentsOver = (context: StoreContext): AccountAttachments => {
  const { database } = context
  const { findAccountPk, findChatPk, chatKeyOf } = keysOver(context)
  return {
    keepDownloads: async (key, chatId, messageId, files) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined || files.length === 0) return 0
      let kept = 0
      write(database, () => {
        kept = attachmentRows.keepDownloads(context, chatKey, messageId, files)
      })
      return kept
    },

    keepProviderRefs: async (key, chatId, messageId, files) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined || files.length === 0) return 0
      let kept = 0
      write(database, () => {
        kept = attachmentRows.keepProviderRefs(context, chatKey, messageId, files)
      })
      return kept
    },

    fileAttachments: async (key, { chatId, ...page }) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return []
      if (chatId === undefined) return attachmentTexts.fileAttachments(context, accountKey, page)
      const chatKey = findChatPk(accountKey, chatId)
      return chatKey === undefined ? [] : attachmentTexts.fileAttachments(context, accountKey, { ...page, chatKey })
    },

    attachments: async (key, { chatId, ...filter }) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return []
      if (chatId === undefined) return attachmentTexts.attachmentViews(context, accountKey, filter)
      const chatKey = findChatPk(accountKey, chatId)
      return chatKey === undefined ? [] : attachmentTexts.attachmentViews(context, accountKey, { ...filter, chatKey })
    },
  }
}

export const attachmentsStoreOver = (context: StoreContext, keyed: AccountAttachments): AttachmentsStore => ({
  ...keyed,
  localPathOf: async (attachmentPk) => attachmentTexts.localPathOf(context, attachmentPk),
  keepAttachmentText: async (attachmentPk, entry) => {
    let kept = false
    write(context.database, () => {
      kept = attachmentTexts.keepText(context, attachmentPk, entry)
    })
    return kept
  },
})
