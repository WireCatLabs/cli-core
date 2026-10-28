import { CliError } from "@wirecat/cli-base"
import PostalMime, { type Address as PostalAddress } from "postal-mime"

export interface Address {
  email: string
  name: string | null
}

export interface ParsedMail {
  subject: string | null
  from: Address | null
  to: Address[]
  cc: Address[]
  bcc: Address[]
  attachments: { id: number; name: string; mime: string | null; bytes: Uint8Array | null }[]
  text: string
}

// The store cuts a body into pieces itself; this only guards against a pathological one, like a pasted log.
export const MAX_BODY_CHARS = 1_000_000

const addresses = (list: PostalAddress[]): Address[] =>
  list
    .flatMap((entry) => entry.group ?? [entry])
    .flatMap(({ address, name }) => (address ? [{ email: address.toLowerCase(), name: name || null }] : []))

const HIDDEN_OPEN = /<(script|style)/gi
const HIDDEN_CLOSE = { script: /<\/script>/gi, style: /<\/style>/gi }
const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }

// `<script[\s\S]*?</script>` as one regex rescans to the end from every unclosed opener; a tag found
// unclosed once stays unclosed for every later opener, so each close is searched for at most once.
const dropHidden = (html: string): string => {
  const unclosed = new Set<string>()
  let out = ""
  let kept = 0
  for (const open of html.matchAll(HIDDEN_OPEN)) {
    const name = (open[1] as string).toLowerCase() as keyof typeof HIDDEN_CLOSE
    if (open.index < kept || unclosed.has(name)) continue
    const close = HIDDEN_CLOSE[name]
    close.lastIndex = open.index + open[0].length
    const end = close.exec(html)
    if (!end) {
      unclosed.add(name)
      continue
    }
    out += html.slice(kept, open.index)
    kept = end.index + end[0].length
  }
  return out + html.slice(kept)
}

// Past the last `>` no tag can close, yet `[^>]+` would rescan to the end from every `<` there: quadratic on `<<<<…`.
const stripTags = (html: string): string => {
  const end = html.lastIndexOf(">") + 1
  return html.slice(0, end).replace(/<[^>]+>/g, "") + html.slice(end)
}

// Comments go first: a tag inside one, like a commented-out link, would leave its text and a stray `-->` behind.
const dropComments = (html: string): string => html.replace(/<!--[\s\S]*?(-->|$)/g, "")

export const htmlToText = (html: string): string =>
  stripTags(dropHidden(dropComments(html)).replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n"))
    // One pass, so `&amp;lt;` stays the text `&lt;` instead of being decoded twice into `<`.
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_entity, name: string) => ENTITIES[name] as string)
    // From the start of a run only: `[ \t]+\n` alone rescans a long run of spaces from each of them.
    .replace(/(?<![ \t])[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

/** Some senders put their HTML in the text/plain part; its first tag gives it away. */
export const looksLikeHtml = (text: string): boolean =>
  /^\s*<(!doctype\s+html|html|head|body|table|div|center|meta|style)\b/i.test(text)

const bytesOf = (content: ArrayBuffer | Uint8Array | string): Uint8Array =>
  typeof content === "string"
    ? new TextEncoder().encode(content)
    : content instanceof Uint8Array
      ? content
      : new Uint8Array(content)

/** A raw RFC 5322 message, as IMAP's `BODY[]` holds it. */
export const parseMail = async (raw: Uint8Array, maxBodyChars = MAX_BODY_CHARS): Promise<ParsedMail> => {
  let email: Awaited<ReturnType<typeof PostalMime.parse>>
  try {
    email = await PostalMime.parse(raw)
  } catch (error) {
    throw new CliError("invalid_response", `unreadable email: ${error instanceof Error ? error.message : error}`)
  }
  const plain = email.text?.trim() ?? ""
  const text = plain && !looksLikeHtml(plain) ? plain : htmlToText(email.html ?? plain)
  return {
    subject: email.subject ?? null,
    from: addresses(email.from === undefined ? [] : [email.from])[0] ?? null,
    to: addresses(email.to ?? []),
    cc: addresses(email.cc ?? []),
    bcc: addresses(email.bcc ?? []),
    attachments: email.attachments.slice(0, 50).map((part, id) => ({
      id,
      name: (part.filename ?? `attachment-${id}`).slice(0, 200),
      mime: part.mimeType || null,
      bytes: bytesOf(part.content),
    })),
    text: text.replace(/\r\n?/g, "\n").slice(0, maxBodyChars),
  }
}
