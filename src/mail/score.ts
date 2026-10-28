import { isDisposableEmailDomain } from "disposable-email-domains-js"
import { getDomain } from "tldts"
import type { Listed } from "./source.js"

/**
 * How much each sign of spam, a scam or a robot adds to a sender's score. Gmail filters spam before it reaches
 * All Mail, so these mostly find what got through: spoofed senders, scams and robots no rule covers yet.
 */
export const WEIGHTS = {
  spam_folder: 4,
  dmarc_fail: 3,
  brand_spoof: 3,
  young_domain: 5,
  reply_to_elsewhere: 1,
  never_opened: 2,
  dkim_not_passed: 2,
  disposable_domain: 2,
  bulk_never_replied: 1,
  replied: -5,
} as const

export type Signal = keyof typeof WEIGHTS

/**
 * The signs of a forged or fraudulent sender, as opposed to how the owner treats ordinary bulk mail. A failed DMARC
 * check is one only beside another: alone it marks real senders with a broken setup or a forwarding path.
 */
export const FRAUD_SIGNALS: readonly Signal[] = ["dmarc_fail", "brand_spoof", "young_domain", "disposable_domain"]

export const SCORE_RULE =
  "score adds: in Gmail's Spam +4, Gmail's DMARC check failed +3 (only beside another sign of fraud), a brand in the display name sent from another " +
  "domain +3, the domain under 180 days old when the mail came +5 (only with looked-up ages), Reply-To on another " +
  "domain +1, none of its mail ever opened +2, Gmail's DKIM check not passed +2, a throwaway-mail domain +2, bulk mail " +
  "never replied to +1, replied to by the owner -5"

/**
 * DMARC failures before this date are not counted: senders then often published a policy their own mail did not yet
 * meet.
 */
export const DMARC_SINCE = "2022-01-01T00:00:00.000Z"

/** A domain registered too recently to trust: under this many days old when the mail arrived. */
export const YOUNG_DAYS = 180

/** What the registry said about a domain; `created` is ISO 8601, `unsupported` when its registry has no RDAP. */
export interface DomainAge {
  created?: string
  unsupported?: boolean
  checkedAt: string
}

/** The part of a host a person registers: `mail.news.example.co.uk` is `example.co.uk`. */
export const registrableOf = (address: string): string => {
  const host = address.slice(address.lastIndexOf("@") + 1).toLowerCase()
  return getDomain(host) ?? host
}

/**
 * The big mailbox providers. Their domains are years old and say nothing about the sender, so they are never
 * looked up; a brand display name sent from one of them is the classic scam.
 */
export const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "yandex.ru",
  "ya.ru",
  "mail.ru",
  "bk.ru",
  "inbox.ru",
  "list.ru",
  "rambler.ru",
  "zoho.com",
])

/** A brand and the first labels of the domains it really sends from. */
const BRANDS: Record<string, string[]> = {
  paypal: ["paypal"],
  apple: ["apple", "icloud"],
  microsoft: [
    "microsoft",
    "outlook",
    "office",
    "office365",
    "live",
    "hotmail",
    "azure",
    "onedrive",
    "microsoftadvertising",
  ],
  google: ["google", "gmail", "youtube", "googlemail"],
  amazon: ["amazon", "amazonaws", "aws"],
  netflix: ["netflix"],
  facebook: ["facebook", "facebookmail", "meta", "fb"],
  instagram: ["instagram", "facebookmail"],
  whatsapp: ["whatsapp"],
  linkedin: ["linkedin"],
  dhl: ["dhl"],
  fedex: ["fedex"],
  docusign: ["docusign"],
  dropbox: ["dropbox", "dropboxmail", "hellosign"],
  binance: ["binance"],
  coinbase: ["coinbase"],
  revolut: ["revolut"],
}

/** Platforms that name courses, spaces and pages after other companies: "Google Cloud" from Coursera is a course. */
const NAMES_OTHERS = new Set(["coursera", "quora"])

const named = (brand: string, text: string) => new RegExp(`\\b${brand}\\b`, "i").test(text)

/**
 * The brand a display name claims while the address belongs to someone else, if any. "Google via LinkedIn" from
 * LinkedIn's own domain is LinkedIn passing a page on; "PayPal via Desk" from anywhere else is still judged whole.
 */
export const spoofedBrand = (name: string | undefined, address: string | undefined): string | undefined => {
  if (name === undefined || address === undefined) return undefined
  const label = registrableOf(address).split(".")[0] ?? ""
  if (NAMES_OTHERS.has(label)) return undefined
  const relay = /\s+via\s+(.+)$/i.exec(name)?.[1]
  if (
    relay !== undefined &&
    Object.entries(BRANDS).some(([brand, owned]) => named(brand, relay) && owned.includes(label))
  )
    return undefined
  return Object.entries(BRANDS).find(([brand, owned]) => named(brand, name) && !owned.includes(label))?.[0]
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Under YOUNG_DAYS old at `at`; false when the age is not known, and when the registration came after `at`: the
 * domain lapsed and someone registered it again later, which says nothing about the mail that came before.
 */
export const youngAt = (age: DomainAge | undefined, at: string): boolean => {
  if (age?.created === undefined) return false
  const old = Date.parse(at) - Date.parse(age.created)
  return old >= 0 && old < YOUNG_DAYS * DAY_MS
}

export interface Scored {
  score: number
  signals: Signal[]
}

const most = (items: Listed[], test: (item: Listed) => boolean | undefined) =>
  items.filter((item) => test(item)).length * 2 >= items.length

/**
 * A sender group's score from the facts its emails carry. A sign counts when it holds for at least half the group's
 * emails, so one odd email does not mark a sender; a spoofed brand counts on any one.
 */
export const scoreGroup = (
  items: Listed[],
  context: { replied: boolean; bulk: number; ages: ReadonlyMap<string, DomainAge> },
): Scored => {
  const signals: Signal[] = []
  const judged = items.filter((item) => item.headers?.auth?.dmarc !== undefined && item.receivedAt >= DMARC_SINCE)
  if (most(items, (item) => item.labels?.includes("Spam"))) signals.push("spam_folder")
  // A failure with a valid DKIM signature is a sender signing for another domain, common before 2021, not a forgery;
  // one that passes DMARC on any of its mail is real, and its failures came by a path that breaks it.
  const forged = (item: Listed) => item.headers?.auth?.dmarc === "fail" && item.headers.auth.dkim !== "pass"
  if (judged.length && most(judged, forged) && !judged.some((item) => item.headers?.auth?.dmarc === "pass"))
    signals.push("dmarc_fail")
  if (items.some((item) => spoofedBrand(item.headers?.fromName, item.headers?.from) !== undefined))
    signals.push("brand_spoof")
  const sender = items.find((item) => item.headers?.from !== undefined)?.headers?.from
  const domain = sender === undefined ? undefined : registrableOf(sender)
  const first = items.reduce((a, b) => (a.receivedAt < b.receivedAt ? a : b))
  if (domain !== undefined && youngAt(context.ages.get(domain), first.receivedAt)) signals.push("young_domain")
  if (
    most(items, (item) => {
      const { from, replyTo } = item.headers ?? {}
      return from !== undefined && replyTo !== undefined && registrableOf(replyTo) !== registrableOf(from)
    })
  )
    signals.push("reply_to_elsewhere")
  const known = items.filter((item) => item.seen !== undefined)
  if (known.length && known.every((item) => !item.seen)) signals.push("never_opened")
  // Gmail's stamp without a dkim= verdict means the mail carried no signature: that counts as not passed.
  const stamped = items.filter((item) => item.headers?.auth !== undefined)
  if (stamped.length && most(stamped, (item) => item.headers?.auth?.dkim !== "pass")) signals.push("dkim_not_passed")
  if (domain !== undefined && isDisposableEmailDomain(domain)) signals.push("disposable_domain")
  if (context.bulk >= 0.8 && !context.replied) signals.push("bulk_never_replied")
  if (context.replied) signals.push("replied")
  const kept =
    signals.includes("dmarc_fail") &&
    !signals.some((signal) => signal !== "dmarc_fail" && FRAUD_SIGNALS.includes(signal))
      ? signals.filter((signal) => signal !== "dmarc_fail")
      : signals
  return { score: kept.reduce((sum, signal) => sum + WEIGHTS[signal], 0), signals: kept }
}
