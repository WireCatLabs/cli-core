/// <reference path="../types/psl.d.ts" />
import { domainToUnicode } from "node:url"
import psl from "psl"
import { googleDocumentId, trimUrl } from "./google-documents.js"
import { DEFAULT_PHONE_COUNTRIES, nationalPhone } from "./phones.js"
import { findPlaces } from "./places.js"

export const MENTION_KINDS = ["phone", "email", "url", "document", "person-name", "place"] as const
export type MentionKind = (typeof MENTION_KINDS)[number]

/** Who decides, and for a name whether every undecided place of it in the same chat follows. */
export interface Decider {
  by: string
  inChat?: boolean
}

/** Bumped when a kind's rule changes, so `mentions rebuild` can redo that kind alone. */
export const MENTION_VERSIONS: Record<MentionKind, number> = {
  phone: 1,
  email: 1,
  url: 2,
  document: 1,
  "person-name": 2,
  place: 1,
}

// Paths of t.me that are not a chat or a person: invites, stickers, proxies, the instant view.
const TELEGRAM_SERVICE_PATHS = new Set([
  "joinchat",
  "addstickers",
  "addemoji",
  "addtheme",
  "share",
  "proxy",
  "socks",
  "iv",
  "login",
])

/**
 * What a Telegram link names, from its stored value: `t.me/<username>` (also `s/<username>` and a post under it) a
 * public chat or a person, `t.me/c/<id>/<post>` a private group or channel by its id. Invites name nothing.
 */
export const telegramTarget = (url: string): { username: string } | { chatId: string } | undefined => {
  const match = /^https?:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?([^/?#]+)(?:\/([^/?#]+))?/i.exec(url)
  const [, first = "", second] = match ?? []
  if (first === "c" && second && /^\d+$/.test(second)) return { chatId: `-100${second}` }
  if (!/^[a-z][a-z0-9_]{3,31}$/i.test(first) || TELEGRAM_SERVICE_PATHS.has(first.toLowerCase())) return undefined
  return { username: first }
}

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
// The words people write before a number, in the languages of the supported countries.
const PHONE_WORD =
  /(?:тел|телефон[а-я]*|моб|мобильн[а-я]*|звони[а-я]*|ватсап|вотсап|phone|tel|mobile|cell|call|whatsapp|m[óo]vil|tel[ée]fono|tfno|tlf|ll[áa]ma(?:me)?|handy|telefon|mobil|t[ée]l[ée]phone|portable|cellulare|telem[óo]vel|telefone)\.?\s*:?\s*$/iu
const NOT_PHONE_WORD =
  /(?:№|#|n[º°o]\.?|заказ[а-я]*|сч[её]т[а-я]*|order|invoice|ref\.?|инн|огрн|бик|кпп|р\/с|к\/с|договор[а-я]*|арт\.|артикул[а-я]*|pedido|factura|fatura|fattura|facture|rechnung|bestell[a-z]*|commande|ordine|encomenda|dni|nie|nif|cif|iban|bic|swift)\s*[:№#]?\s*$/iu
const CURRENCY_BEFORE = /[$€₽£]\s*$/u
const CURRENCY_AFTER = /^\s*(?:[$€₽£]|руб|р\.|eur|usd|rub|тыс|млн)/iu
const DATE = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$|^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/
const IP = /^\d{1,3}(?:\.\d{1,3}){3}$/
const RUSSIAN_GROUPS = /\d{3}[ \u00a0\-–]\d{2}[ \u00a0\-–]\d{2}$/
const SPANISH_GROUPS = /^[6-9]\d{2}[ \u00a0\-–]\d{3}[ \u00a0\-–]\d{3}$/

export interface PhoneOptions {
  /** Where a number written without `+` is read, first match first: the store's `phone_countries`. */
  phoneCountries?: readonly string[]
}

/**
 * Looks like a phone, not a checked one: a wrong guess costs one `dismissed`, a miss a search that finds nothing.
 * `+` or `00` makes it international. Without them the number is read in the store's countries: grouped or after
 * a phone word any valid number, bare digits only a mobile.
 */
const phones = (text: string, urlSpans: FoundMention[], countries: readonly string[]): FoundMention[] => {
  const found: FoundMention[] = []
  for (const match of text.matchAll(PHONE_CANDIDATE)) {
    const written = match[0]
    const start = match.index
    const end = start + written.length
    if (urlSpans.some((url) => start < url.end && end > url.start)) continue
    const international = written.startsWith("+") || /^00[1-9]/.test(written)
    // `+44 (0)20 …`: the bracketed trunk prefix is not dialled from abroad.
    const digits = (international ? written.replace(/\(0\)/, "") : written)
      .replace(SEPARATORS, "")
      .replace(/^\+|^00/, "")
    if (digits.length < 7 || digits.length > 15 || DATE.test(written) || IP.test(written)) continue
    const before = text.slice(Math.max(0, start - 25), start)
    const after = text.slice(end, end + 6)
    if (NOT_PHONE_WORD.test(before) || CURRENCY_BEFORE.test(before) || CURRENCY_AFTER.test(after)) continue
    const named = PHONE_WORD.test(before)
    const grouped = written !== written.replace(SEPARATORS, "")
    const shaped =
      (international && digits.length >= 10) ||
      /\(\d{3,5}\)/.test(written) ||
      RUSSIAN_GROUPS.test(written) ||
      SPANISH_GROUPS.test(written)
    if (international) {
      if (!shaped && !named) continue
      found.push({ kind: "phone", start, end, value: `+${digits}`, domain: null, confidence: 0.9 })
      continue
    }
    const national = nationalPhone(digits, countries, { anyType: named || grouped })
    if (national) {
      const confidence = named || grouped ? 0.9 : 0.7
      found.push({ kind: "phone", start, end, value: national.value, domain: null, confidence })
    } else if (shaped || named) found.push({ kind: "phone", start, end, value: digits, domain: null, confidence: 0.5 })
  }
  return found
}

/** Every phone, e-mail address, link, Google document and address in the text, in the order they are written. */
export const findMentions = (text: string, { phoneCountries = DEFAULT_PHONE_COUNTRIES }: PhoneOptions = {}) => {
  const mail = emails(text)
  const links = urls(text).filter((url) => !mail.some((one) => url.start < one.end && url.end > one.start))
  const places = findPlaces(text)
    .filter((place) => ![...mail, ...links].some((one) => place.start < one.end && place.end > one.start))
    .map((place): FoundMention => ({ kind: "place", ...place, domain: null }))
  const numbers = phones(text, [...links, ...mail], phoneCountries).filter(
    (phone) => !places.some((place) => phone.start < place.end && phone.end > place.start),
  )
  return [...mail, ...links, ...numbers, ...places].sort((a, b) => a.start - b.start || a.end - b.end)
}

// A mail link with a query or a long opaque token is mostly a one-off tracking redirect: hundreds of thousands per
// mailbox, each in one letter.
const OPAQUE = /[A-Za-z0-9_-]{24,}/

/**
 * Mail keeps such links once per letter and site, as the site's origin, so `domain:` and `mentions domains` still
 * find the letter; `written` still reads the link as it was sent.
 */
export const oneTrackedLinkPerSite = <T extends { kind: MentionKind; value: string }>(found: T[]): T[] => {
  const sites = new Set<string>()
  return found.flatMap((one) => {
    const origin = one.kind === "url" ? trackedOrigin(one.value) : undefined
    if (origin === undefined) return [one]
    if (sites.has(origin)) return []
    sites.add(origin)
    return [{ ...one, value: origin }]
  })
}

/** The origin mail stores a stored link's value as, when it keeps only one row per letter and site for it. */
export const trackedOrigin = (value: string): string | undefined => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  return url.search || OPAQUE.test(url.pathname) ? url.origin : undefined
}

/** A value as a person types it, in the form mentions store: `8 900 000-00-01` → `+79000000001`. */
export const normalizedValue = (typed: string, options: PhoneOptions = {}): string =>
  typedPhone(typed, options)?.value ?? exactlyOne(typed.trim(), options) ?? typed.trim().toLowerCase()

const exactlyOne = (text: string, options: PhoneOptions) => {
  const [one] = findMentions(text, options)
  return one && one.start === 0 && one.end === text.length ? one.value : undefined
}

/**
 * A number typed into a search, read as if a phone word stood before it, and the national number every stored
 * spelling of it ends with — at least 8 digits, so a short tail does not match unrelated numbers.
 */
export const typedPhone = (
  typed: string,
  { phoneCountries = DEFAULT_PHONE_COUNTRIES }: PhoneOptions = {},
): { value: string; national: string | null } | undefined => {
  const text = typed.trim()
  if (!/^\+?[\d\s().\-–]+$/.test(text)) return undefined
  const digits = text.replace(/\(0\)/, "").replace(/\D/g, "").replace(/^00/, "")
  if (digits.length < 7 || digits.length > 15) return undefined
  const national = nationalPhone(digits, phoneCountries, { anyType: true })
  const tail = national?.national ?? digits.replace(/^0+/, "")
  return {
    value: text.startsWith("+") || /^00/.test(text) ? `+${digits}` : (national?.value ?? digits),
    national: tail.length >= 8 ? tail : null,
  }
}
