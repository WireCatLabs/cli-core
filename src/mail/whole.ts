import { CliError } from "@wirecat/cli-base"
import { importEngine } from "../attachments/extract.js"
import type { LoadEngine } from "../readers/types.js"
import type { MessageStore } from "../store/index.js"
import { mailAccountKey } from "./account-key.js"
import { type AttachmentLog, MAX_ATTACHMENT_CHARS, readAttachments } from "./attachments.js"
import { parsedEmail } from "./email-input.js"
import { mailHeadersOf } from "./headers.js"
import { MAX_BODY_CHARS, parseMail } from "./parse.js"
import { PARTIAL } from "./partial.js"
import type { Listed, MailSource, Quick } from "./source.js"

export interface WholeAttachment {
  position: number
  name: string
  mime: string | null
  /** `null` when the email held no content for it. */
  bytes: Uint8Array | null
  status: string
}

/**
 * Reads one stored email from its source again and every attachment of it, whatever its size: what a person asks for
 * by name is read even when a sync's policy left it. The new text is saved as a sync saves it, so the search index
 * takes it; the files are only answered, never written. Gmail's email is found by its id in `folders`; elsewhere it is
 * read at its newest stored place, trusted only when `identify` gives the stored id for the bytes read there.
 */
export const readEmailWhole = async ({
  store,
  source,
  address,
  externalId,
  folders,
  maxBodyChars = MAX_BODY_CHARS,
  maxAttachmentChars = MAX_ATTACHMENT_CHARS,
  loadEngine = importEngine,
  now = Date.now(),
}: {
  store: MessageStore
  source: MailSource
  address: string
  externalId: string
  folders: () => Promise<readonly string[]>
  maxBodyChars?: number
  maxAttachmentChars?: number
  loadEngine?: LoadEngine
  now?: number
}): Promise<WholeAttachment[]> => {
  const { id: accountId } = await store.accounts.storedAccount(mailAccountKey(address))
  const stored = await store.mail.emailPlace(accountId, externalId)
  if (stored === null) throw new CliError("not_found", `${externalId} is not stored for ${address}`)
  let item: Quick | Listed | undefined
  if (source.find)
    for (const folder of await folders()) {
      item = (await source.find([externalId], folder)).find(({ messageId }) => messageId === externalId)
      if (item) break
    }
  else {
    const place = stored.locations[0]
    if (place)
      item = {
        uid: String(place.uid),
        folder: place.folder,
        validity: place.uidvalidity,
        receivedAt: new Date(stored.receivedAt ?? 0).toISOString(),
      }
  }
  if (item === undefined) throw new CliError("not_found", `the mail server no longer gives ${externalId}`)
  const [raw] = await source.fetchRaw([item])
  if (!(raw instanceof Uint8Array))
    throw new CliError("provider_unavailable", `${externalId} could not be read from the mail server`)
  if (!source.find && source.identify?.(raw, item).messageId !== externalId)
    throw new CliError("not_found", `the mail server holds another email where ${externalId} was`)
  const mail = await parseMail(raw, maxBodyChars)
  const log: AttachmentLog = []
  const files = await readAttachments(mail, externalId, { loadEngine, maxAttachmentChars, at: now }, log)
  const { [PARTIAL]: _partial, ...metadata } = stored.metadata ?? {}
  const whole: Listed = { ...item, messageId: externalId, threadId: stored.threadExternalId }
  await store.mail.saveThread({
    accountId,
    externalId: stored.threadExternalId,
    now,
    emails: [
      {
        ...parsedEmail(mail, whole, mailHeadersOf(raw), address),
        receivedAt: stored.receivedAt,
        size: raw.byteLength,
        metadata,
        attachments: files,
      },
    ],
  })
  return mail.attachments.map((part, position) => ({
    position,
    name: part.name,
    mime: part.mime,
    bytes: part.bytes,
    status: log[position]?.status ?? "unavailable",
  }))
}
