import type { Id } from "../../domain/models.js"

export type TextOrigin = "extracted" | "agent"

/** One stored file attachment that extraction may read. */
export interface FileAttachment {
  pk: number
  chatId: Id
  messageId: Id
  /** From 0, as stored. */
  position: number
  kind: string
  name: string | null
  mime: string | null
  size: number | null
  localPath: string | null
  /** What an earlier run left, when it read this file. */
  read: {
    origin: TextOrigin
    bytes: number | null
    error: string | null
    contentSha256?: string | null
    extractor?: string
  } | null
}

export interface AttachmentTextEntry {
  text: string
  origin: TextOrigin
  extractor: string
  contentSha256?: string | null
  bytes?: number | null
  error?: string | null
}

/** One file attachment and what the store holds of its text — never the text itself. */
export interface AttachmentView {
  pk: number
  chatId: Id
  messageId: Id
  position: number
  kind: string
  name: string | null
  localPath: string | null
  text: { origin: TextOrigin; extractor: string; chars: number; error: string | null } | null
}
