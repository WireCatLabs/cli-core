import { parseLocator } from "../domain/locator.js"
import { readMail } from "../services/mail-search.js"
import type { Saved } from "../services/message-resolution.js"
import type { SearchFound } from "../services/messages.js"
import { searchStore } from "../services/messages-archive-search.js"
import type { AccountKey, MessageStore, StoredHit } from "../store/store.js"

/** Mail from senders with signs of fraud after the rest of the page, each part in the order it had. */
export const lowerSuspicious = <T>(items: readonly T[], suspicious: (item: T) => boolean): T[] => [
  ...items.filter((item) => !suspicious(item)),
  ...items.filter(suspicious),
]

/** A few more than asked, so mail moved down makes room for the next best rather than an empty slot. */
const LOWERED_SPARE = 20

export interface MailSearch {
  text: string
  limit: number
  offset?: number
  /** Only these mailboxes; every stored one when neither this nor `mailAccount` is given. */
  accounts?: AccountKey[]
  /** Only this mailbox, by its address. */
  mailAccount?: string
  exact?: boolean
  timezone?: string
  newest?: boolean
  /** Leave mail from suspicious senders where the words put it, instead of after the rest. */
  plainOrder?: boolean
  /** Only these emails, by thread and email id: `--backend server` reads what the server returned. */
  only?: (AccountKey & { chatId: string; id: string })[]
}

/**
 * Stored mail by the shared query language, best first. Mail whose sender search demotes comes after the rest,
 * unless `plainOrder` or `newest` asks for another order. `runAs` is the account the search runs as.
 */
export const searchMail = async (
  store: MessageStore,
  runAs: AccountKey,
  { text, limit, offset = 0, accounts, mailAccount, exact, timezone, newest, plainOrder, only }: MailSearch,
  saved: Saved = {},
): Promise<SearchFound> => {
  const lower = !plainOrder && !newest
  const request = {
    text,
    kind: "mail" as const,
    ...(accounts === undefined ? {} : { accounts }),
    ...(mailAccount === undefined ? {} : { mailAccount }),
    ...(exact ? { exact: true } : {}),
    ...(timezone === undefined ? {} : { timezone }),
    ...(newest ? { newest: true } : {}),
    ...(only === undefined ? {} : { only }),
  }
  if (!lower) return searchStore(store, runAs, { ...request, limit, offset }, saved)
  // Lowered from the first hit on, so a later page never repeats or skips what an earlier one moved.
  const found = await searchStore(store, runAs, { ...request, limit: offset + limit + LOWERED_SPARE }, saved)
  const items = lowerSuspicious(found.items, (item) => item.email?.senderScore?.demoted === true)
  const hasMore = found.hasMore || items.length > offset + limit
  const { nextOffset: _, ...rest } = found
  return {
    ...rest,
    items: items.slice(offset, offset + limit),
    hasMore,
    ...(hasMore ? { nextOffset: offset + limit } : {}),
  }
}

/** Enough for a bill's amounts and dates; the whole text is asked for separately. */
export const ATTACHMENT_CHARS = 4000

export type ShownMail = StoredHit & { anchor?: true }

interface StoredFile {
  text: string | null
  extraction: string | null
  extractionError: string | null
}

/** The HTML and AMP alternatives of the body: markup, not attachments, and thousands of characters each. */
const isBodyAlternative = (attachment: { mime?: string | null }) =>
  attachment.mime === "text/html" || attachment.mime === "text/x-amp-html"

/** The extracted text of each attachment, next to the name the email lists; a file without text says why. */
export const withAttachmentText = (hit: ShownMail, files: readonly StoredFile[], full: boolean): ShownMail => ({
  ...hit,
  attachments: (hit.attachments ?? [])
    .map((attachment, at) => ({ attachment, file: files[at] }))
    .filter(({ attachment }) => full || !isBodyAlternative(attachment))
    .map(({ attachment, file }) => {
      const text = file?.text ?? ""
      if (!text) return { ...attachment, extraction: file?.extractionError ?? file?.extraction ?? "none" }
      const cut = !full && text.length > ATTACHMENT_CHARS
      return {
        ...attachment,
        text: cut ? text.slice(0, ATTACHMENT_CHARS) : text,
        text_chars: text.length,
        ...(cut ? { text_cut: true } : {}),
      }
    }),
})

/**
 * One stored email by its `msg:email/…` locator, with up to `before` and `after` emails of its thread, each with
 * the text of its attachments: the first `ATTACHMENT_CHARS` of each, or all of it and the HTML body with `full`.
 */
export const showMail = async (
  store: MessageStore,
  locator: string,
  { before = 0, after = 0, full = false }: { before?: number; after?: number; full?: boolean } = {},
): Promise<ShownMail[]> => {
  const shown = await readMail(store, locator, { before, after })
  const account = await store.accounts.storedAccount({ provider: "email", account: parseLocator(locator).account })
  if (!account) return shown
  return Promise.all(
    shown.map(async (hit) => {
      if (!hit.attachments?.length) return hit
      const email = await store.mail.email(account.id, hit.id)
      return withAttachmentText(hit, email?.attachments ?? [], full)
    }),
  )
}

const line = (text: string) => text.replace(/\s+/g, " ").trim()

/**
 * A found message or email for a reader: its reference first, then when and from whom, who else it went to and
 * where it is filed, its subject or chat, and an excerpt — the whole text only at `full`.
 */
export const hitText = (item: StoredHit & { excerpt?: string }, level?: "brief" | "full"): string => {
  const mail = item.email
  const names = (people: { name: string | null; address: string }[]) =>
    people.map(({ name, address }) => line(name ?? address)).join(", ")
  const between = mail
    ? [
        mail.to.length ? `to ${names(mail.to)}` : "",
        mail.cc.length ? `cc ${names(mail.cc)}` : "",
        mail.labels.join(", "),
      ]
        .filter(Boolean)
        .join(" · ")
    : ""
  const who = line(item.senderName ?? item.senderId ?? "unknown")
  return [
    item.locator,
    `  ${item.timestamp}  ${who}${level === "brief" || !between ? "" : `  ${between}`}`,
    ...(level === "brief" || !item.chatTitle ? [] : [`  ${line(item.chatTitle)}`]),
    `  ${level === "full" ? item.text.replace(/\n/g, "\n  ") : line(item.excerpt ?? item.text)}`,
  ].join("\n")
}

/** Each attachment of a shown email with its text indented under it, or why it has none. */
export const attachmentsText = (hit: ShownMail): string =>
  (hit.attachments ?? [])
    .map((attachment) => {
      const file = attachment as typeof attachment & { text?: string; text_chars?: number; extraction?: string }
      const name = file.name ?? file.kind
      if (file.text === undefined) return `  ── attachment ${name}: no text (${file.extraction}) ──`
      const cut = file.text.length < (file.text_chars ?? 0) ? `, first ${file.text.length} of ${file.text_chars}` : ""
      return `  ── attachment ${name} (${file.text_chars} characters${cut}) ──\n  ${file.text.replace(/\n/g, "\n  ")}`
    })
    .join("\n")
