import { decodeWords } from "postal-mime"

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
 * The verdicts in Gmail's own Authentication-Results. Only the copy Gmail stamps as mx.google.com counts: a sender
 * can add one under any other name, and Gmail removes forged copies under its own (RFC 8601 §5).
 */
export const authOf = (unfolded: string): AuthVerdicts | undefined => {
  const stamped = fieldsOf(unfolded, "Authentication-Results").find((value) => /^mx\.google\.com\s*;/i.test(value))
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

export const addressesOf = (value: string | undefined): string[] => {
  if (value === undefined) return []
  const bracketed = [...value.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].map(([, address]) => address as string)
  const found = bracketed.length ? bracketed : (value.match(/[^\s<>,;:"()]+@[^\s<>,;:"()]+/g) ?? [])
  return found.map((address) => address.toLowerCase())
}

const nameOf = (value: string): string | undefined => {
  const before = /^\s*(.*?)\s*<[^<>]+>\s*$/.exec(value)?.[1]
  const name = before?.replace(/^"(.*)"$/, "$1").trim()
  return name ? decodeWords(name) : undefined
}

const listIdOf = (raw: string | undefined): string | undefined =>
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

/**
 * List-Id, the bulk-mail fields, Reply-To and Gmail's SPF, DKIM and DMARC verdicts of a whole email, kept on mail
 * stored in full so a rule or a sender score can be worked out from the store later. Names are lower case.
 */
export const mailHeadersOf = (raw: Uint8Array): Record<string, string | boolean> => {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  const end = [bytes.indexOf("\r\n\r\n"), bytes.indexOf("\n\n")].filter((at) => at !== -1)
  const head = bytes.subarray(0, end.length ? Math.min(...end) : Math.min(bytes.length, 256 * 1024))
  const unfolded = unfold(head.toString("utf8"))
  const listId = listIdOf(field(unfolded, "List-Id"))
  const precedence = field(unfolded, "Precedence")?.trim().toLowerCase()
  const [replyTo] = addressesOf(field(unfolded, "Reply-To"))
  return {
    ...(listId ? { "list-id": listId } : {}),
    ...(replyTo === undefined ? {} : { "reply-to": replyTo }),
    ...authOf(unfolded),
    ...(field(unfolded, "List-Unsubscribe") === undefined ? {} : { "list-unsubscribe": true }),
    ...(precedence ? { precedence } : {}),
  }
}
