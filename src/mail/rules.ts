import type { MailHeaders } from "./headers.js"
import { type PresetName, presetMatches } from "./presets.js"

/** All given conditions must hold; a rule with none matches nothing. */
export interface MailRuleMatch {
  from?: string
  /** A word the sender's address or display name contains, any case: Gmail's `from:smith`. */
  from_contains?: string
  domain?: string
  /** One recipient address in To or Cc. */
  to?: string
  list_id?: string
  /** Words that must all appear in the subject, any case. */
  subject?: string
  older_than_days?: number
  larger_than_bytes?: number
  /** Sent as `multipart/mixed`, the way mail with attachments is. */
  has_attachments?: boolean
  /** A Gmail label, by its plain name: `Promotions`, `Inbox`, or one the owner made. */
  label?: string
  unread?: boolean
  /** List-Id, List-Unsubscribe or `Precedence: bulk`. */
  bulk?: boolean
  /** The sender's score (memo mail inspect) is at least this. */
  score_at_least?: number
  /** A built-in kind of mail, see presets.ts. */
  preset?: PresetName
}

export type MailAction = "skip" | "envelope" | "keep"

export interface MailRule {
  /** The store's id; absent until the rule is saved. */
  id?: number
  match: MailRuleMatch
  /** skip: never read or stored · envelope: stored without its text, so it can be counted and cleaned later. */
  action: MailAction
  /** memo tags put on every email the rule matches, with any action. */
  tags?: string[]
  /** Tags the store refused with no label to reuse, and why; the mail is stored untagged. */
  tags_skipped?: Record<string, string>
  reason?: string
  /** Stored in full, and no cleanup may cut, archive or trash it, whatever other rules or presets say. */
  protected?: boolean
  /** owner, preset:<name>, probe or gmail-filter. */
  source?: string
  decided_at: string
}

/** What is known of one email when a rule decides it: its headers at list time, and what the listing says. */
export interface MailFacts {
  headers?: MailHeaders
  receivedAt?: string
  size?: number
  labels?: string[]
  seen?: boolean
  /** The sender group's score, when a rule asks for one. */
  score?: number
  /** The owner wrote to this sender. */
  replied?: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1)

/** A domain also matches its subdomains: bulk mail often comes from `mail.` or `news.` of the same domain. */
const domainMatches = (wanted: string, sender: string | undefined): boolean => {
  if (sender === undefined) return false
  const host = domainOf(sender)
  const domain = wanted.toLowerCase()
  return host === domain || host.endsWith(`.${domain}`)
}

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean)

/** Unknown facts never match: a rule about size skips an email whose size the listing did not give. */
export const matches = (match: MailRuleMatch, facts: MailFacts, now = Date.now()): boolean => {
  const conditions = Object.entries(match).filter(([, value]) => value !== undefined)
  if (conditions.length === 0) return false
  const { headers } = facts
  return conditions.every(([key, value]) => {
    switch (key as keyof MailRuleMatch) {
      case "from":
        return headers?.from === String(value).toLowerCase()
      case "from_contains": {
        const word = String(value).toLowerCase()
        return [headers?.from, headers?.fromName?.toLowerCase()].some((part) => part?.includes(word) ?? false)
      }
      case "domain":
        return domainMatches(String(value), headers?.from)
      case "to":
        return headers?.to.includes(String(value).toLowerCase()) ?? false
      case "list_id":
        return headers?.listId === String(value).toLowerCase()
      case "subject": {
        const subject = headers?.subject?.toLowerCase()
        return subject !== undefined && words(String(value)).every((word) => subject.includes(word))
      }
      case "older_than_days":
        return facts.receivedAt !== undefined && now - Date.parse(facts.receivedAt) > Number(value) * DAY_MS
      case "larger_than_bytes":
        return facts.size !== undefined && facts.size > Number(value)
      case "has_attachments":
        return headers !== undefined && (headers.attachments === true) === value
      case "label":
        return facts.labels?.some((label) => label.toLowerCase() === String(value).toLowerCase()) ?? false
      case "unread":
        return facts.seen !== undefined && !facts.seen === value
      case "bulk":
        return headers !== undefined && headers.bulk === value
      case "score_at_least":
        return facts.score !== undefined && facts.score >= Number(value)
      case "preset":
        return presetMatches(value as PresetName, facts)
      default:
        return false
    }
  })
}

const RANK: Record<MailAction, number> = { keep: 0, envelope: 1, skip: 2 }

const strength = (rule: MailRule) =>
  (rule.protected ? 0 : 10) + RANK[rule.action] + (rule.source?.startsWith("preset:") ? 5 : 0)

/**
 * The rule that decides an email. A protected rule wins over everything and keeps the mail whole; then keep wins
 * over envelope, envelope over skip, so a keep for one sender overrides a skip of its domain and mail both record
 * and drop rules match is recorded, since a record can be cleaned later. An explicit rule wins over a preset.
 */
export const decide = (rules: readonly MailRule[], facts: MailFacts | undefined): MailRule | undefined => {
  if (facts?.headers === undefined) return undefined
  const now = Date.now()
  const hit = rules.filter((rule) => matches(rule.match, facts, now)).sort((a, b) => strength(a) - strength(b))[0]
  return hit?.protected ? { ...hit, action: "keep" } : hit
}

/** The tags of every rule that matches, whichever rule decides the action. */
export const tagsOf = (rules: readonly MailRule[], facts: MailFacts): string[] => {
  if (facts.headers === undefined) return []
  const now = Date.now()
  return [...new Set(rules.flatMap((rule) => (rule.tags?.length && matches(rule.match, facts, now) ? rule.tags : [])))]
}

/** The only conditions an envelope mailbox can be named by: one sender, domain or list. */
const SINGLE: readonly (keyof MailRuleMatch)[] = ["from", "domain", "list_id"]

export const conditionKeys = (match: MailRuleMatch) =>
  (Object.keys(match) as (keyof MailRuleMatch)[]).filter((key) => match[key] !== undefined).sort()

/** A short, stable name of a match: `domain shop.example`, or `subject invoice, larger_than_bytes 1000`. */
export const describeMatch = (match: MailRuleMatch): string =>
  conditionKeys(match)
    .map((key) => `${key === "list_id" ? "list-id" : key.replace(/_/g, "-")} ${String(match[key])}`)
    .join(", ")

/** Where the store keeps the emails one envelope rule recorded: a mailbox of its own, per rule. */
export const envelopeBox = (match: MailRuleMatch) => {
  const keys = conditionKeys(match)
  const single = keys.length === 1 && SINGLE.includes(keys[0] as keyof MailRuleMatch)
  const [kind, value] = single
    ? [keys[0] === "list_id" ? "list-id" : String(keys[0]), String(match[keys[0] as keyof MailRuleMatch])]
    : ["rule", describeMatch(match)]
  return {
    externalId: `memo:envelope:${kind}:${value.toLowerCase()}`,
    name: `envelope: ${kind} ${value}`,
    kind: ENVELOPE,
  }
}

export const ENVELOPE = "envelope"

const normalized = (match: MailRuleMatch) =>
  JSON.stringify(
    conditionKeys(match).map((key) => {
      const value = match[key]
      return [key, typeof value === "string" ? value.toLowerCase() : value]
    }),
  )

export const sameMatch = (a: MailRuleMatch, b: MailRuleMatch): boolean => normalized(a) === normalized(b)

export const envelopeBoxOf = (externalId: string) => {
  const [, , kind, ...value] = externalId.split(":")
  return { externalId, name: `envelope: ${kind} ${value.join(":")}`, kind: ENVELOPE }
}
