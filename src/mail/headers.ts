import { decodeWords } from "postal-mime"
import { registrableOf } from "./score.js"

/**
 * The header fields memo reads at list time: enough to group mail by sender, apply the owner's rules and keep
 * an envelope of the mail a rule records without its text.
 */
export const HEADER_FIELDS =
  "FROM TO CC SUBJECT LIST-ID LIST-UNSUBSCRIBE PRECEDENCE REPLY-TO AUTHENTICATION-RESULTS CONTENT-TYPE"

/** SPF, DKIM and DMARC as Gmail judged them when the email arrived; each absent when Gmail did not say. */
export interface AuthVerdicts {
  spf?: string
  dkim?: string
  dmarc?: string
}

export interface MailHeaders {
  /** The sender's address, lower case; absent when From holds none. */
  from?: string
  /** The sender's display name, decoded. */
  fromName?: string
  subject?: string
  /** To and Cc addresses, lower case. */
  to: string[]
  listId?: string
  /** List-Id, List-Unsubscribe or `Precedence: bulk|list|junk`: mail sent to many, not written to one. */
  bulk: boolean
  /** The first Reply-To address, lower case. */
  replyTo?: string
  auth?: AuthVerdicts
  /** `Content-Type: multipart/mixed`: how mail with attachments is sent. A guess, not a parse of the body. */
  attachments?: boolean
}

export const unfold = (text: string): string => text.replace(/\r?\n[ \t]+/g, " ")

export const field = (unfolded: string, name: string): string | undefined =>
  new RegExp(`^${name}:[ \\t]*(.*?)\\r?$`, "im").exec(unfolded)?.[1]

const fieldsOf = (unfolded: string, name: string): string[] =>
  [...unfolded.matchAll(new RegExp(`^${name}:[ \\t]*(.*?)\\r?$`, "gim"))].map(([, value]) => value as string)

/**
 * Gmail's own Authentication-Results. Only the copy Gmail stamps as mx.google.com counts: a sender can add one under
 * any other name, and Gmail removes forged copies under its own (RFC 8601 §5).
 */
const gmailStampOf = (unfolded: string): string | undefined =>
  fieldsOf(unfolded, "Authentication-Results").find((value) => /^mx\.google\.com\s*;/i.test(value))

/** The verdicts in Gmail's own Authentication-Results. */
export const authOf = (unfolded: string): AuthVerdicts | undefined => {
  const stamped = gmailStampOf(unfolded)
  if (stamped === undefined) return undefined
  const results = [...stamped.matchAll(/\b(spf|dkim|dmarc)=([a-z]+)/gi)].map(([, method, result]) => [
    (method as string).toLowerCase(),
    (result as string).toLowerCase(),
  ])
  const verdicts: AuthVerdicts = {}
  for (const [method, result] of results) {
    const key = method as keyof AuthVerdicts
    // An email can carry several DKIM signatures; one that passes is enough.
    if (verdicts[key] === undefined || result === "pass") verdicts[key] = result
  }
  return Object.keys(verdicts).length ? verdicts : undefined
}

const tagsOf = (value: string): Map<string, string> =>
  new Map(
    value.split(";").flatMap((tag) => {
      const at = tag.indexOf("=")
      return at === -1 ? [] : [[tag.slice(0, at).trim().toLowerCase(), tag.slice(at + 1).replace(/\s+/g, "")]]
    }),
  )

/**
 * The header fields a DKIM signature Gmail passed covers, when that signature's domain is the From's own (its
 * registrable domain). A sender writes every header itself; only a signature of its own domain vouches for one.
 * Without Gmail's stamp nothing is trusted: other servers' Authentication-Results may be the sender's own.
 */
export const signedFieldsOf = (unfolded: string, from: string | undefined): Set<string> => {
  const stamped = gmailStampOf(unfolded)
  if (stamped === undefined || from === undefined) return new Set()
  const passed = [...stamped.matchAll(/\bdkim=pass\b[^;]*?\bheader\.[id]=([^\s;]+)/gi)].map(([, identity]) =>
    (identity as string).slice((identity as string).lastIndexOf("@") + 1).toLowerCase(),
  )
  const own = registrableOf(from)
  const signed = new Set<string>()
  for (const signature of fieldsOf(unfolded, "DKIM-Signature")) {
    const tags = tagsOf(signature)
    const domain = tags.get("d")?.toLowerCase()
    if (domain === undefined || registrableOf(domain) !== own) continue
    if (!passed.some((one) => one === domain || one.endsWith(`.${domain}`))) continue
    for (const name of (tags.get("h") ?? "").split(":")) if (name !== "") signed.add(name.toLowerCase())
  }
  return signed
}

/**
 * What says a program or a list sent the mail, each only when DKIM vouches for it (`signedFieldsOf`):
 * `Auto-Submitted` other than `no` (RFC 3834), the one-click unsubscribe of RFC 8058 and Google's `Feedback-ID`.
 * An empty Return-Path is the receiving server's, not the sender's, and marks a program unless it is an auto-reply,
 * which RFC 3834 sends that way too: a person's out-of-office makes no bot.
 */
const programSignalsOf = (unfolded: string, from: string | undefined): Record<string, string | boolean> => {
  const signed = signedFieldsOf(unfolded, from)
  const submitted = field(unfolded, "Auto-Submitted")
    ?.trim()
    .toLowerCase()
    .split(/[\s;(]/)[0]
  const generated = submitted !== undefined && submitted !== "" && submitted !== "no" && submitted !== "auto-replied"
  const oneClick = /list-unsubscribe\s*=\s*one-click/i.test(field(unfolded, "List-Unsubscribe-Post") ?? "")
  return {
    ...(generated && signed.has("auto-submitted") ? { "auto-submitted": submitted } : {}),
    ...(oneClick && signed.has("list-unsubscribe-post") ? { "list-unsubscribe-post": true } : {}),
    ...(field(unfolded, "Feedback-ID") !== undefined && signed.has("feedback-id") ? { "feedback-id": true } : {}),
    ...(/^\s*<\s*>/.test(field(unfolded, "Return-Path") ?? "") && submitted !== "auto-replied"
      ? { "null-return-path": true }
      : {}),
  }
}

/**
 * The https and mailto targets of List-Unsubscribe (RFC 2369), each the first of its scheme, kept only when the From
 * domain's DKIM signature covers the field: a target is where an unsubscribe goes, so a forged one must not be offered.
 */
const unsubscribeTargetsOf = (unfolded: string, from: string | undefined): Record<string, string> => {
  const value = field(unfolded, "List-Unsubscribe")
  if (value === undefined || !signedFieldsOf(unfolded, from).has("list-unsubscribe")) return {}
  const targets = [...value.matchAll(/<\s*([^<>\s]+)\s*>/g)].map(([, target]) => target as string)
  const https = targets.find((target) => /^https:\/\/[^/\s]/i.test(target))
  const mailto = targets.find((target) => /^mailto:[^@\s]+@[^@\s]+/i.test(target))
  return {
    ...(https === undefined ? {} : { "list-unsubscribe-https": https }),
    ...(mailto === undefined ? {} : { "list-unsubscribe-mailto": mailto }),
  }
}

export const addressesOf = (value: string | undefined): string[] => {
  if (value === undefined) return []
  // A display name may itself look like an address ("bob@y.com" <real@z.com>), so quoted names and comments go first.
  const bare = value.replace(/"(?:[^"\\]|\\.)*"/g, " ").replace(/\([^()]*\)/g, " ")
  return [...bare.matchAll(/<([^<>\s]+@[^<>\s]+)>|([^\s<>,;:"()]+@[^\s<>,;:"()]+)/g)].map(([, bracketed, plain]) =>
    String(bracketed ?? plain).toLowerCase(),
  )
}

const nameOf = (value: string): string | undefined => {
  const before = /^\s*(.*?)\s*<[^<>]+>\s*$/.exec(value)?.[1]
  const name = before?.replace(/^"(.*)"$/, "$1").trim()
  return name ? decodeWords(name) : undefined
}

/** A List-Id as the store keeps it: the part inside angle brackets, lower case. */
export const listIdOf = (raw: string | undefined): string | undefined =>
  raw === undefined ? undefined : (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim().toLowerCase() || undefined

/** The header fields of one email, from its header text. */
export const headersOf = (text: string): MailHeaders => {
  const unfolded = unfold(text)
  const sender = field(unfolded, "From")
  const [from] = addressesOf(sender)
  const fromName = sender === undefined ? undefined : nameOf(sender)
  const subject = field(unfolded, "Subject")
  const listId = listIdOf(field(unfolded, "List-Id"))
  const [replyTo] = addressesOf(field(unfolded, "Reply-To"))
  const auth = authOf(unfolded)
  const bulk =
    Boolean(listId) ||
    field(unfolded, "List-Unsubscribe") !== undefined ||
    /^(bulk|list|junk)\b/i.test(field(unfolded, "Precedence") ?? "")
  return {
    ...(from === undefined ? {} : { from }),
    ...(fromName ? { fromName } : {}),
    ...(subject === undefined ? {} : { subject: decodeWords(subject).trim() }),
    to: [...addressesOf(field(unfolded, "To")), ...addressesOf(field(unfolded, "Cc"))],
    ...(listId ? { listId } : {}),
    bulk,
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(auth === undefined ? {} : { auth }),
    ...(/^\s*multipart\/mixed\b/i.test(field(unfolded, "Content-Type") ?? "") ? { attachments: true } : {}),
  }
}

const headTextOf = (raw: Uint8Array): string => {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  const end = [bytes.indexOf("\r\n\r\n"), bytes.indexOf("\n\n")].filter((at) => at !== -1)
  return bytes.subarray(0, end.length ? Math.min(...end) : Math.min(bytes.length, 256 * 1024)).toString("utf8")
}

/** The header fields of a whole email, as `headersOf` reads them from a listing. */
export const headersOfRaw = (raw: Uint8Array): MailHeaders => headersOf(headTextOf(raw))

/**
 * List-Id, the bulk-mail fields, Reply-To, Gmail's SPF, DKIM and DMARC verdicts, the unsubscribe targets
 * (`unsubscribeTargetsOf`) and what marks a program or a list (`programSignalsOf`) of a whole email, kept on mail
 * stored in full so a rule, a sender score or a person's kind can be worked out from the store later. Names are lower
 * case.
 */
export const mailHeadersOf = (raw: Uint8Array): Record<string, string | boolean> => {
  const unfolded = unfold(headTextOf(raw))
  const listId = listIdOf(field(unfolded, "List-Id"))
  const precedence = field(unfolded, "Precedence")?.trim().toLowerCase()
  const [replyTo] = addressesOf(field(unfolded, "Reply-To"))
  const [from] = addressesOf(field(unfolded, "From"))
  return {
    ...(listId ? { "list-id": listId } : {}),
    ...(replyTo === undefined ? {} : { "reply-to": replyTo }),
    ...authOf(unfolded),
    ...(field(unfolded, "List-Unsubscribe") === undefined ? {} : { "list-unsubscribe": true }),
    ...(precedence ? { precedence } : {}),
    ...unsubscribeTargetsOf(unfolded, from),
    ...programSignalsOf(unfolded, from),
  }
}
