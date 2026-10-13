import type { Id } from "../../domain/models.js"

/** A stored message whose text may hold a Google document link, with the documents a link joins it to. */
export interface DocumentLinkMessage {
  messageId: Id
  text: string
  sentAt: string
  senderId: Id | null
  senderName: string | null
  /** The live stored documents linked from it, by the Google file id in their front matter. */
  documents: { fileId: string; title: string | null }[]
}
