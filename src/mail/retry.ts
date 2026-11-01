import { CliError } from "@wirecat/cli-base"
import type { LoadEngine } from "../readers/types.js"
import type { MessageStore } from "../store/index.js"
import { mailAccountKey } from "./account-key.js"
import { type AttachmentLog, addressOf, FETCH_CHUNK, readAttachments } from "./attachments.js"
import { mailFolders } from "./folders.js"
import { mailHeadersOf } from "./headers.js"
import { type ParsedMail, parseMail } from "./parse.js"
import type { Listed, MailSource } from "./source.js"
import type { MailAccount, MailSyncOptions, MailSyncResult } from "./sync.js"

/** Failures a newer install mends: the reader was missing, not the file at fault, so reading again can succeed. */
export const RETRYABLE_ATTACHMENTS = ["engine-missing"]

/**
 * Reads again, by Gmail id, only the stored emails with an attachment a missing reader left unread: memo keeps no
 * attachment file, so the email comes from the source again. Nothing is listed, so no deletion is proved and no
 * resume point moves; the email keeps its stored mailboxes, flags and rule.
 */
export const retryUnread = async ({
  store,
  source,
  account,
  since,
  max,
  maxBodyChars,
  maxAttachmentChars,
  now,
  loadEngine,
  index,
}: {
  store: MessageStore
  source: MailSource
  account: MailAccount
  since: Date
  max: number
  maxBodyChars: number
  maxAttachmentChars: number
  now: () => number
  loadEngine: LoadEngine
  index: MailSyncOptions["index"]
}): Promise<MailSyncResult> => {
  const startedAt = now()
  const key = mailAccountKey(account.address)
  const find = source.find
  if (find === undefined)
    throw new CliError(
      "validation_error",
      "--retry-attachments reads mail again by its Gmail id; an mbox file or a plain IMAP account has none",
    )
  const accountId = await store.accounts.saveAccount(key, { name: account.address })
  const wanted = (await store.mail.emailRefs({ accountId, attachmentErrors: RETRYABLE_ATTACHMENTS })).map(
    ({ externalId }) => externalId,
  )
  const chosen = wanted.slice(0, max)
  const found = new Map<string, Listed>()
  for (const folder of await mailFolders(account, source)) {
    const left = chosen.filter((id) => !found.has(id))
    if (left.length === 0) break
    for (const item of await find(left, folder)) if (!found.has(item.messageId)) found.set(item.messageId, item)
  }
  const items = [...found.values()]
  const attachments: AttachmentLog = []
  const unreadable: NonNullable<MailSyncResult["unreadable"]> = []
  let emails = 0
  let extracted = 0
  let stillFailed = 0
  for (let start = 0; start < items.length; start += FETCH_CHUNK) {
    const chunk = items.slice(start, start + FETCH_CHUNK)
    const raws = await source.fetchRaw(chunk)
    for (const [index, item] of chunk.entries()) {
      const raw = raws[index]
      const stored = await store.mail.email(accountId, item.messageId)
      if (stored === null) continue
      let mail: ParsedMail
      try {
        if (raw === undefined || raw instanceof Error) throw raw ?? new Error("not read")
        mail = await parseMail(raw, maxBodyChars)
      } catch (error) {
        unreadable.push({ message: item.messageId, reason: error instanceof Error ? error.message : String(error) })
        continue
      }
      const before = new Map(stored.attachments.map(({ position, extractionError }) => [position, extractionError]))
      const files = await readAttachments(
        mail,
        item.messageId,
        { loadEngine, maxAttachmentChars, at: startedAt },
        attachments,
      )
      for (const file of files)
        if (RETRYABLE_ATTACHMENTS.includes(before.get(file.position) ?? ""))
          if (file.extraction === "text") extracted++
          else stillFailed++
      const header = mailHeadersOf(raw as Uint8Array)
      await store.mail.saveThread({
        accountId,
        externalId: item.threadId,
        now: startedAt,
        emails: [
          {
            externalId: item.messageId,
            subject: mail.subject,
            from: mail.from === null ? null : addressOf(mail.from),
            to: mail.to.map(addressOf),
            cc: mail.cc.map(addressOf),
            bcc: mail.bcc.map(addressOf),
            sentAt: null,
            receivedAt: Date.parse(item.receivedAt),
            bodyText: mail.text || null,
            size: item.size ?? stored.size,
            ...(Object.keys(header).length ? { headers: header } : {}),
            outgoing: mail.from === null ? null : mail.from.email === key.account,
            mailboxes: stored.mailboxes.map(({ externalId, name, kind }) => ({ externalId, name, kind })),
            ...(stored.read === null ? {} : { read: stored.read }),
            ...(stored.flagged === null ? {} : { flagged: stored.flagged }),
            metadata: stored.metadata,
            mailRuleId: stored.mailRuleId,
            attachments: files,
          },
        ],
      })
      emails++
    }
  }
  const indexed = await index?.(store, key)
  return {
    account: key.account,
    since: since.toISOString(),
    listed: items.length,
    saved: 0,
    alreadyStored: 0,
    skipped: 0,
    envelopes: 0,
    deleted: 0,
    complete: wanted.length <= max && unreadable.length === 0,
    ...(indexed === undefined ? {} : { indexed }),
    retried: { emails, extracted, stillFailed, missing: chosen.length - items.length },
    ...(attachments.length ? { attachments } : {}),
    ...(unreadable.length ? { unreadable } : {}),
  }
}
