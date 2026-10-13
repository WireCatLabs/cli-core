import type { DownloadedFile } from "../../domain/attachments.js"
import type { Id } from "../../domain/models.js"
import type { AttachmentTextEntry, AttachmentView, FileAttachment } from "./attachment-texts-types.js"
import type { AccountKey } from "./models.js"

export interface AttachmentsStore {
  /** What a voice message said, when it was heard before, and by what. */
  transcript(key: AccountKey, chatId: Id, messageId: Id): Promise<{ text: string; source: string } | undefined>

  /** Keeps a finished transcript; an empty one is not kept, so the message is heard again. */
  keepTranscript(key: AccountKey, chatId: Id, messageId: Id, text: string, source: string): Promise<void>

  /**
   * Where `messages download` saved a held message's files, for reading them later. Answers how many
   * attachments it recorded: a file it cannot tell apart from another is not recorded.
   */
  keepDownloads(key: AccountKey, chatId: Id, messageId: Id, files: readonly DownloadedFile[]): Promise<number>

  /** File attachments of this account's live messages, newest first, below `beforePk`; never one an agent wrote. */
  fileAttachments(
    key: AccountKey,
    page: { chatId?: Id; messageId?: Id; beforePk?: number; limit: number },
  ): Promise<FileAttachment[]>

  /** File attachments of live messages and what is held of their text, newest first; never the text. */
  attachments(
    key: AccountKey,
    filter: { chatId?: Id; messageId?: Id; needsText?: boolean; offset?: number; limit: number },
  ): Promise<AttachmentView[]>

  /** Where the file of one attachment was saved, when that is recorded. */
  localPathOf(attachmentPk: number): Promise<string | null>

  /** An extraction never replaces an agent's text; answers whether it was kept. */
  keepAttachmentText(attachmentPk: number, entry: AttachmentTextEntry): Promise<boolean>

  /** The kinds of attachment held, for `has:` to name the ones it can find. */
  attachmentKinds(): Promise<string[]>
}
