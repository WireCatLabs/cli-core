/// <reference path="../types/psl.d.ts" />
import { domainToUnicode } from "node:url"
import psl from "psl"
import { googleDocumentId, trimUrl } from "./google-documents.js"

export const MENTION_KINDS = ["phone", "email", "url", "document"] as const
export type MentionKind = (typeof MENTION_KINDS)[number]

/** Bumped when a kind's rule changes, so `mentions rebuild` can redo that kind alone. */
export const MENTION_VERSIONS: Record<MentionKind, number> = { phone: 1, email: 1, url: 1, document: 1 }

/** One value found in a text, before it is stored. */
export interface FoundMention {
  kind: MentionKind
  /** UTF-16 offsets into the text, as JavaScript counts them. */
  start: number
  end: number
  value: string
  /** `url` and `email` only: the site the value belongs to, `google.com` for `docs.google.com`. */
  domain: string | null
  confidence: number
}

/** The site a host belongs to, from the public suffix list: `docs.google.com` → `google.com`. */
export const siteOf = (host: string): string => {
  const unicode = domainToUnicode(host) || host
  return psl.get(unicode) ?? unicode
}

const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@((?:[\p{L}\p{N}-]+\.)+\p{L}{2,})(?![\p{L}\p{N}-])/gu

const emails = (text: string): FoundMention[] =>
  [...text.matchAll(EMAIL)].map((match) => {
    const host = String(match[1]).toLowerCase()
    return {
      kind: "email",
      start: match.index,
      end: match.index + match[0].length,
      value: match[0].toLowerCase(),
      domain: siteOf(host),
      confidence: 0.95,
    }
  })

const SCHEME_URL = /\bhttps?:\/\/[^\s<>"'`«»]+/giu
const BARE_URL = /(?<![\p{L}\p{N}@._/-])(?:www\.)?(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?:\/[^\s<>"'`«»]*)?/gu
// Suffixes that are real top-level domains and also common file extensions: `readme.md` is a file, not a site.
const FILE_SUFFIXES = new Set(["md", "py", "sh", "pl", "rs", "cc", "cs", "ps", "rb", "mov", "zip", "im"])
const TRACKING = /^(?:utm_.+|fbclid|gclid|yclid|mc_cid|mc_eid|_openstat)$/i

const normalizedUrl = (written: string): { value: string; host: string } | null => {
  let parsed: URL
  try {
    parsed = new URL(/^https?:\/\//i.test(written) ? written : `https://${written}`)
  } catch {
    return null
  }
  if (/^[\d.]+$/.test(parsed.hostname) || parsed.hostname.startsWith("[")) return null
  for (const key of [...parsed.searchParams.keys()]) if (TRACKING.test(key)) parsed.searchParams.delete(key)
  parsed.hash = ""
  const host = domainToUnicode(parsed.hostname) || parsed.hostname
  const path = parsed.pathname === "/" ? "" : parsed.pathname
  return { value: `${parsed.protocol}//${host}${path}${parsed.search}`, host }
}

const urls = (text: string): FoundMention[] => {
  const found: FoundMention[] = []
  const add = (start: number, written: string, confidence: number) => {
    const url = normalizedUrl(written)
    if (!url) return
    const end = start + written.length
    found.push({ kind: "url", start, end, value: url.value, domain: siteOf(url.host), confidence })
    const documentId = googleDocumentId(url.value)
    if (documentId) found.push({ kind: "document", start, end, value: documentId, domain: null, confidence: 0.95 })
  }
  for (const match of text.matchAll(SCHEME_URL)) add(match.index, trimUrl(match[0]), 0.95)
  const taken = (at: number) => found.some((one) => at >= one.start && at < one.end)
  for (const match of text.matchAll(BARE_URL)) {
    if (taken(match.index)) continue
    const written = trimUrl(match[0])
    const writtenHost = written.split("/")[0] ?? ""
    const host = writtenHost.toLowerCase()
    const suffix = host.split(".").at(-1) ?? ""
    // Code reads like a bare domain: `cache.at(i)`, `items.parts[0]`, `sync.Map`.
    const code =
      /\p{Lu}/u.test(writtenHost.split(".").at(-1) ?? "") || /^[([]/.test(text[match.index + written.length] ?? "")
    const parsed = psl.parse(host)
    if (code || FILE_SUFFIXES.has(suffix) || "error" in parsed || !parsed.listed) continue
    add(match.index, written, host.startsWith("www.") ? 0.9 : 0.6)
  }
  return found
}

const PHONE_CANDIDATE =
  /(?<![\p{L}\p{N}/@_+-]|\d[.,])\+?\(?\d[\d \u00a0\u2009\u202f().\-–]{5,24}\d(?![\p{L}\p{N}/@_]|[.,]\d)/gu
const SEPARATORS = /[ \u00a0\u2009\u202f().\-–]/g
const PHONE_WORD = /(?:тел|телефон[а-я]*|моб|мобильн[а-я]*|phone|tel|whatsapp|ватсап|вотсап|звони[а-я]*)\.?\s*:?\s*$/iu
const NOT_PHONE_WORD =
  /(?:№|#|заказ[а-я]*|сч[её]т[а-я]*|order|invoice|инн|огрн|бик|кпп|р\/с|к\/с|договор[а-я]*|арт\.|артикул[а-я]*)\s*[:№#]?\s*$/iu
const CURRENCY_BEFORE = /[$€₽£]\s*$/u
const CURRENCY_AFTER = /^\s*(?:[$€₽£]|руб|р\.|eur|usd|rub|тыс|млн)/iu
const DATE = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$|^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/
const IP = /^\d{1,3}(?:\.\d{1,3}){3}$/
const RUSSIAN_GROUPS = /\d{3}[ \u00a0\-–]\d{2}[ \u00a0\-–]\d{2}$/
const SPANISH_GROUPS = /^[6-9]\d{2}[ \u00a0\-–]\d{3}[ \u00a0\-–]\d{3}$/

const phoneValue = (written: string, digits: string): { value: string; known: boolean } => {
  if (written.startsWith("+")) return { value: `+${digits}`, known: true }
  if (digits.length === 11 && /^[78]/.test(digits)) return { value: `+7${digits.slice(1)}`, known: true }
  if (digits.length === 10 && digits.startsWith("9")) return { value: `+7${digits}`, known: true }
  return { value: digits, known: false }
}

/** Looks like a phone, not a checked one: a wrong guess costs one `dismissed`, a miss a search that finds nothing. */
const phones = (text: string, urlSpans: FoundMention[]): FoundMention[] => {
  const found: FoundMention[] = []
  for (const match of text.matchAll(PHONE_CANDIDATE)) {
    const written = match[0]
    const start = match.index
    const end = start + written.length
    if (urlSpans.some((url) => start < url.end && end > url.start)) continue
    const digits = written.replace(SEPARATORS, "").replace(/^\+/, "")
    if (digits.length < 7 || digits.length > 15 || DATE.test(written) || IP.test(written)) continue
    const before = text.slice(Math.max(0, start - 25), start)
    const after = text.slice(end, end + 6)
    if (NOT_PHONE_WORD.test(before) || CURRENCY_BEFORE.test(before) || CURRENCY_AFTER.test(after)) continue
    const shaped =
      (written.startsWith("+") && digits.length >= 10) ||
      /\(\d{3,5}\)/.test(written) ||
      RUSSIAN_GROUPS.test(written) ||
      SPANISH_GROUPS.test(written)
    const bareMobile = /^(?:[78]9\d{9}|9\d{9})$/.test(written)
    const named = PHONE_WORD.test(before)
    if (!shaped && !bareMobile && !named) continue
    const { value, known } = phoneValue(written, digits)
    const confidence = !known ? 0.5 : shaped || named ? 0.9 : 0.7
    found.push({ kind: "phone", start, end, value, domain: null, confidence })
  }
  return found
}

/** Every phone, e-mail address, link and Google document in the text, in the order they are written. */
export const findMentions = (text: string): FoundMention[] => {
  const mail = emails(text)
  const links = urls(text).filter((url) => !mail.some((one) => url.start < one.end && url.end > one.start))
  return [...mail, ...links, ...phones(text, [...links, ...mail])].sort((a, b) => a.start - b.start || a.end - b.end)
}

/** A value as a person types it, in the form mentions store: `8 900 000-00-01` → `+79000000001`. */
export const normalizedValue = (typed: string): string => {
  const [one] = findMentions(typed.trim())
  return one && one.start === 0 && one.end === typed.trim().length ? one.value : typed.trim().toLowerCase()
}
