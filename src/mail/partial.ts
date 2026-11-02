import type { BudgetStop } from "../background/budget.js"
import type { LoadEngine } from "../readers/types.js"
import type { MessageStore, PartialEmail } from "../store/index.js"
import { type AttachmentLog, FETCH_CHUNK, readAttachments } from "./attachments.js"
import { parsedEmail } from "./email-input.js"
import { mailHeadersOf } from "./headers.js"
import { parseMail } from "./parse.js"
import type { Listed, MailSource, Quick } from "./source.js"

/** The `emails.metadata` key of an email stored from its first bytes: `{ bytes }` read of its `size`. */
export const PARTIAL = "partial"

/** How many partial emails one sync reads whole at most; the rest wait for the next run. */
export const PARTIAL_PER_RUN = 100

export interface PartialOutcome {
  /** Read whole this run, the mark cleared. */
  completed: number
  /** Still partial after this run. */
  left: number
}

/**
 * Reads whole the emails a server search stored from their first bytes, so the archive holds their attachments too.
 * Sync never reads stored mail again, so without this step a partial email would stay partial. Gmail's are found by
 * their id; elsewhere at a stored location, trusted only when the bytes read there carry the stored id.
 */
export const completePartial = async ({
  store,
  source,
  accountId,
  address,
  folders,
  maxBodyChars,
  maxAttachmentChars,
  loadEngine,
  now,
  take,
  signal,
}: {
  store: MessageStore
  source: MailSource
  accountId: number
  address: string
  /** Where Gmail's are looked for by id; asked only when a partial email is there to read. */
  folders: () => Promise<readonly string[]>
  maxBodyChars: number
  maxAttachmentChars: number
  loadEngine: LoadEngine
  now: number
  /** A budgeted run's next request, or why there is none. */
  take?: () => BudgetStop | null
  signal?: AbortSignal
}): Promise<PartialOutcome> => {
  const { emails, total } = await store.mail.partialEmails(accountId, PARTIAL_PER_RUN)
  if (emails.length === 0) return { completed: 0, left: 0 }
  const byId = new Map(emails.map((email) => [email.externalId, email]))
  const items = new Map<PartialEmail, Quick | Listed>()
  if (source.find) {
    for (const folder of await folders()) {
      const left = emails.filter((email) => !items.has(email)).map(({ externalId }) => externalId)
      if (left.length === 0) break
      if (take?.()) return { completed: 0, left: total }
      for (const found of await source.find(left, folder)) {
        const email = byId.get(found.messageId)
        if (email && !items.has(email)) items.set(email, found)
      }
    }
  } else if (source.identify)
    for (const email of emails) {
      const place = email.locations[0]
      if (place)
        items.set(email, {
          uid: String(place.uid),
          folder: place.folder,
          receivedAt: new Date(email.receivedAt ?? 0).toISOString(),
        })
    }
  let completed = 0
  const wanted = [...items]
  for (let start = 0; start < wanted.length; start += FETCH_CHUNK) {
    if (signal?.aborted || take?.()) break
    const chunk = wanted.slice(start, start + FETCH_CHUNK)
    let raws: (Uint8Array | Error)[]
    try {
      raws = await source.fetchRaw(chunk.map(([, item]) => item))
    } catch {
      // A partial email stays readable as it is; the next run tries again.
      break
    }
    const attachments: AttachmentLog = []
    for (const [index, [email, item]] of chunk.entries()) {
      const raw = raws[index]
      if (!(raw instanceof Uint8Array)) continue
      // A UID means another message after a UIDVALIDITY change; only the stored id proves it is this one.
      if (!source.find && source.identify?.(raw, item).messageId !== email.externalId) continue
      try {
        const mail = await parseMail(raw, maxBodyChars)
        const files = await readAttachments(
          mail,
          email.externalId,
          { loadEngine, maxAttachmentChars, at: now, ...(signal ? { signal } : {}) },
          attachments,
        )
        const { [PARTIAL]: _partial, ...metadata } = email.metadata ?? {}
        const whole: Listed = { ...item, messageId: email.externalId, threadId: email.threadExternalId }
        await store.mail.saveThread({
          accountId,
          externalId: email.threadExternalId,
          now,
          emails: [
            {
              ...parsedEmail(mail, whole, mailHeadersOf(raw), address),
              receivedAt: email.receivedAt,
              size: raw.byteLength,
              metadata,
              attachments: files,
            },
          ],
        })
        completed++
      } catch {
        if (signal?.aborted) break
      }
    }
  }
  return { completed, left: total - completed }
}
