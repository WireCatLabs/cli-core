import { getDomain } from "tldts"
import { listIdOf } from "./headers.js"
import type { MailType } from "./mail-types.js"

/** What a sorting rule names, most specific first. @experimental */
export const SORT_SCOPES = ["mail", "list", "subject", "address", "domain"] as const
/** @experimental */
export type SortScope = (typeof SORT_SCOPES)[number]

/** A List-Id and a subject pattern are one level: neither is more specific than the other. */
const LEVEL: Record<SortScope, number> = { mail: 1, list: 2, subject: 2, address: 3, domain: 4 }

/** @experimental */
export type SortAuthor = "owner" | "program"

/** One sorting rule as the matcher reads it. @experimental */
export interface SortRuleFacts {
  id: number
  scope: SortScope
  value: string
  author: SortAuthor
  /** A domain rule that beats the address rules at its domain. */
  overAddresses: boolean
  /** `false`: only mail dated from `createdAt` on. */
  past: boolean
  createdAt: number
}

/** What a rule is matched against for one email. @experimental */
export interface SortedMail {
  id: number
  /** Lower case. */
  from: string | null
  subject: string | null
  /** As `listIdOf` keeps it. */
  list: string | null
  /** The mail's own date, ms. */
  at: number | null
}

/** A subject pattern: any case, and any number stands for any other, so "Order 4411" matches "order 9". */
export const subjectKeyOf = (text: string): string =>
  text.toLowerCase().replace(/\d+/g, "0").replace(/\s+/g, " ").trim()

const hostOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1)

/** The registrable domains a host sits under, itself first: `a.mail.shop.example` → `mail.shop.example`, `shop.example`… */
const suffixesOf = (host: string): string[] => {
  const labels = host.split(".")
  return labels.slice(0, -1).map((_, at) => labels.slice(at).join("."))
}

/** The owner's rule first, then the newest. */
const before = (a: SortRuleFacts, b: SortRuleFacts) =>
  (a.author === "owner" ? 0 : 1) - (b.author === "owner" ? 0 : 1) || b.createdAt - a.createdAt || b.id - a.id

/** Rules filed by what they name, each list in the order a match takes them. @experimental */
export interface SortIndex<R extends SortRuleFacts> {
  byKey: Map<string, R[]>
  subjects: R[]
  size: number
}

const keyOf = (scope: SortScope, value: string) => `${scope}\u0000${value}`

/** @experimental */
export const sortIndexOf = <R extends SortRuleFacts>(rules: readonly R[]): SortIndex<R> => {
  const byKey = new Map<string, R[]>()
  const subjects: R[] = []
  for (const rule of rules) {
    if (rule.scope === "subject") subjects.push(rule)
    else byKey.set(keyOf(rule.scope, rule.value), [...(byKey.get(keyOf(rule.scope, rule.value)) ?? []), rule])
  }
  for (const list of byKey.values()) list.sort(before)
  return { byKey, subjects: subjects.sort(before), size: rules.length }
}

const applies = (rule: SortRuleFacts, mail: SortedMail) => rule.past || (mail.at !== null && mail.at >= rule.createdAt)

const first = <R extends SortRuleFacts>(rules: readonly R[], mail: SortedMail): R | undefined =>
  rules.find((rule) => applies(rule, mail))

/**
 * The rule that decides this email, the first scope that has one: the mail, its List-Id or a subject pattern, its
 * address, its domain. Within a scope the owner's rule beats the program's and the newest wins. A domain rule marked
 * `overAddresses` beats the address rules. Addresses match whole and domains on a label boundary, so `ann@` never
 * matches `joann@` and `shop.example` never matches `myshop.example`. @experimental
 */
export const sortRuleFor = <R extends SortRuleFacts>(index: SortIndex<R>, mail: SortedMail): R | undefined => {
  if (index.size === 0) return undefined
  const at = (scope: SortScope, value: string | null) =>
    value === null ? undefined : first(index.byKey.get(keyOf(scope, value)) ?? [], mail)
  const own = at("mail", String(mail.id))
  if (own !== undefined) return own
  const subject = mail.subject === null ? undefined : subjectKeyOf(mail.subject)
  const second = [
    at("list", mail.list),
    subject === undefined
      ? undefined
      : first(
          index.subjects.filter((rule) => subject.includes(rule.value)),
          mail,
        ),
  ].filter((rule): rule is R => rule !== undefined)
  if (second.length > 0) return second.sort(before)[0]
  if (mail.from === null || !mail.from.includes("@")) return undefined
  const domain = suffixesOf(hostOf(mail.from))
    .map((host) => at("domain", host))
    .find((rule) => rule !== undefined)
  if (domain?.overAddresses) return domain
  return at("address", mail.from) ?? domain
}

/** Whether a scope is more specific than another. @experimental */
export const narrower = (a: SortScope, b: SortScope): boolean => LEVEL[a] < LEVEL[b]

/** What a rule of this scope keeps as its value, or `undefined` when the value names nothing. @experimental */
export const sortValueOf = (scope: SortScope, value: string | number): string | undefined => {
  const text = String(value).trim()
  if (scope === "mail") return /^[1-9]\d*$/.test(text) ? text : undefined
  if (scope === "list") return listIdOf(text)
  if (scope === "subject") return subjectKeyOf(text) || undefined
  if (scope === "address") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text.toLowerCase() : undefined
  return getDomain(text.replace(/^.*@/, "").toLowerCase()) ?? undefined
}

/** What a rule sets on mail and on its sender. @experimental */
export interface SortAction {
  mailType?: MailType
  sender?: "bot" | "person"
  /** `organization:<id>`. */
  organization?: string
}
