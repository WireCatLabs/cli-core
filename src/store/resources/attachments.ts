import type { AttachmentsStore } from "../contracts/attachments.js"
import * as attachmentTexts from "../sqlite/attachment-texts.js"
import * as attachmentRows from "../sqlite/attachments.js"
import * as transcripts from "../sqlite/transcripts.js"
import type { StoreRuntime } from "./runtime.js"

export const attachmentsStoreOver = ({
  context,
  database,
  inTransaction,
  accountPk,
  findAccountPk,
  findChatPk,
  chatKeyOf,
  chatPkFor,
}: Pick<
  StoreRuntime,
  "context" | "database" | "inTransaction" | "accountPk" | "findAccountPk" | "findChatPk" | "chatKeyOf" | "chatPkFor"
>): AttachmentsStore => {
  return {
    transcript: async (key, chatId, messageId) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      return chatKey === undefined ? undefined : transcripts.transcript(context, chatKey, messageId)
    },

    keepTranscript: async (key, chatId, messageId, text, source) => {
      if (text.trim() === "") return
      inTransaction(() =>
        transcripts.keepTranscript(context, chatPkFor(accountPk(key), chatId), messageId, text, source),
      )
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

    localPathOf: async (attachmentPk) => attachmentTexts.localPathOf(context, attachmentPk),

    keepAttachmentText: async (attachmentPk, entry) => {
      let kept = false
      inTransaction(() => {
        kept = attachmentTexts.keepText(context, attachmentPk, entry)
      })
      return kept
    },

    keepDownloads: async (key, chatId, messageId, files) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined || files.length === 0) return 0
      let kept = 0
      inTransaction(() => {
        kept = attachmentRows.keepDownloads(context, chatKey, messageId, files)
      })
      return kept
    },

    attachmentKinds: async () =>
      database
        .prepare("SELECT DISTINCT kind FROM attachments ORDER BY kind")
        .all()
        .map((row) => String(row.kind)),
  }
}
