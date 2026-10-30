import { extractText } from "../attachments/extract.js"
import type { LoadEngine } from "../readers/types.js"
import type { AttachmentInput, EmailAddress } from "../store/index.js"
import type { Address, ParsedMail } from "./parse.js"
import type { MailSyncResult } from "./sync.js"

export const MAX_ATTACHMENT_CHARS = 200_000
/** One chunk of raw mail is held in memory at a time. */
export const FETCH_CHUNK = 50

export const addressOf = ({ email, name }: Address): EmailAddress => ({ address: email, name })

export type AttachmentLog = NonNullable<MailSyncResult["attachments"]>

/** A parsed email's attachments as the store keeps them, each with its text or why it has none. */
export const readAttachments = async (
  mail: ParsedMail,
  messageId: string,
  { loadEngine, maxAttachmentChars, at }: { loadEngine: LoadEngine; maxAttachmentChars: number; at: number },
  log: AttachmentLog,
): Promise<AttachmentInput[]> => {
  const files: AttachmentInput[] = []
  for (const [position, part] of mail.attachments.entries()) {
    const extraction =
      part.bytes === null
        ? { status: "unavailable" as const }
        : await extractText(part.bytes, { kind: "file", name: part.name, mime: part.mime, path: part.name }, loadEngine)
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
