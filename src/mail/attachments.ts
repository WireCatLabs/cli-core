import { extractText } from "../attachments/extract.js"
import type { LoadEngine } from "../readers/types.js"
import type { AttachmentInput, EmailAddress } from "../store/index.js"
import type { Address, ParsedMail } from "./parse.js"
import type { MailSyncResult } from "./sync.js"

export const MAX_ATTACHMENT_CHARS = 200_000

/** Whether a sync reads an email's attachments into the index, and the largest file it reads. */
export interface MailAttachmentPolicy {
  read: boolean
  maxBytes: number
}

/** On, up to 10 MB a file: ordinary documents and scans are read, a large archive or video is not. */
export const DEFAULT_ATTACHMENT_POLICY: MailAttachmentPolicy = { read: true, maxBytes: 10 * 1024 * 1024 }

/** Why a policy left an attachment unread; `readEmailWhole` reads it anyway. */
export const POLICY_SKIPS = ["not-read", "too-large"] as const
/** One chunk of raw mail is held in memory at a time. */
export const FETCH_CHUNK = 50

export const addressOf = ({ email, name }: Address): EmailAddress => ({ address: email, name })

export type AttachmentLog = NonNullable<MailSyncResult["attachments"]>

/**
 * A parsed email's attachments as the store keeps them, each with its text or why it has none. Without `policy` every
 * attachment is read, whatever its size.
 */
export const readAttachments = async (
  mail: ParsedMail,
  messageId: string,
  {
    loadEngine,
    maxAttachmentChars,
    at,
    signal,
    policy,
  }: {
    loadEngine: LoadEngine
    maxAttachmentChars: number
    at: number
    signal?: AbortSignal
    policy?: MailAttachmentPolicy
  },
  log: AttachmentLog,
): Promise<AttachmentInput[]> => {
  const files: AttachmentInput[] = []
  for (const [position, part] of mail.attachments.entries()) {
    if (signal?.aborted) throw signal.reason
    const skipped =
      part.bytes === null || policy === undefined
        ? undefined
        : !policy.read
          ? ("not-read" as const)
          : part.bytes.byteLength > policy.maxBytes
            ? ("too-large" as const)
            : undefined
    const extraction =
      part.bytes === null
        ? { status: "unavailable" as const }
        : skipped
          ? { status: skipped }
          : await extractText(
              part.bytes,
              { kind: "file", name: part.name, mime: part.mime, path: part.name },
              loadEngine,
              signal,
            )
    log.push({ message: messageId, part: part.id, status: extraction.status })
    const extracted = extraction.status === "extracted" ? extraction : undefined
    files.push({
      position,
      kind: "file",
      mime: part.mime,
      name: part.name,
      title: null,
      url: null,
      size: part.bytes === null ? null : part.bytes.byteLength,
      width: null,
      height: null,
      duration: null,
      providerRef: { message: messageId, part: part.id },
      localPath: null,
      text: extracted ? extracted.text.slice(0, maxAttachmentChars) : null,
      normalizedText: null,
      extraction: extracted ? "text" : "failed",
      extractor: extracted ? extracted.extractor : null,
      extractionError: extracted ? null : extraction.status,
      contentSha256: null,
      extractedAt: at,
    })
  }
  return files
}
