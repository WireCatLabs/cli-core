import { CliError } from "@wirecat/cli-base"
import type { MessageStore, SenderScore } from "../store/index.js"
import { mailAccountKey } from "./account-key.js"
import { domainsToAge, groupKey, probeMail } from "./probe.js"
import { decide, type MailRule } from "./rules.js"
import { type DomainAge, FRAUD_SIGNALS, FREE_MAIL, registrableOf, WEIGHTS } from "./score.js"
import { listedOf } from "./stored.js"

const SCORED = "mail_sender_scores"

export interface LookupResult {
  looked: number
  failed: number
}

/** Registration dates of sender domains: the ones already known, and a lookup for the rest. */
export interface DomainAges {
  known: () => ReadonlyMap<string, DomainAge>
  lookUp: (domains: readonly string[]) => Promise<LookupResult>
}
/** Raised when the weights or the signals change, so every sender is scored again on the next sync. */
export const SCORE_VERSION = 4
/** Signs of fraud adding up to this rank a sender's mail lower in search. */
export const DEMOTE_AT = 3
const DAY = 86_400_000
/** Only senders heard from this recently are looked up: an older sender's domain may have lapsed or changed hands. */
const RECENT = 2 * 365 * DAY

/**
 * Scores every sender of the account from the mail the store holds, as `memo mail inspect` scores a listing, and
 * keeps the scores in the store, where search shows them. At most once a day, or at once after SCORE_VERSION
 * changes. A sender in several groups (its own mail and a list) keeps the highest score. Domains not yet aged are
 * looked up first, for senders heard from in the last two years.
 */
export const scoreSenders = async (
  store: MessageStore,
  address: string,
  ages: DomainAges,
  now = Date.now(),
  rules: readonly MailRule[] = [],
): Promise<{ scored: number; looked: number; failed: number; demoted: number } | undefined> => {
  const key = mailAccountKey(address)
  const last = (await store.sync.syncState(key, SCORED))?.value
  const done = last === undefined ? undefined : (JSON.parse(last) as { version: number; at: number })
  if (done !== undefined && done.version === SCORE_VERSION && now - done.at < DAY) return undefined
  const stored = await store.accounts.storedAccount(key).catch((error: unknown) => {
    if (error instanceof CliError && error.code === "not_found") return null
    throw error
  })
  if (stored === null) return undefined
  const items = (await store.mail.emailFacts({ accountId: stored.id })).map((email) => {
    const item = listedOf(email)
    return email.outgoing && !item.labels?.includes("Sent")
      ? { ...item, labels: [...(item.labels ?? []), "Sent"] }
      : item
  })
  // Each registry learns only its own domains' names; big mailbox providers and senders the owner wrote to are never asked.
  const latest = new Map<string, string>()
  for (const item of items) {
    if (item.headers === undefined) continue
    const key = groupKey(item.headers)
    if ((latest.get(key) ?? "") < item.receivedAt) latest.set(key, item.receivedAt)
  }
  const since = new Date(now - RECENT).toISOString()
  const recent = probeMail(items, Number.MAX_SAFE_INTEGER).items.filter(
    (group) =>
      (latest.get(
        groupKey({
          ...(group.from === null ? {} : { from: group.from }),
          ...(group.listId === null ? {} : { listId: group.listId }),
        }),
      ) ?? "") >= since,
  )
  const lookups = await ages.lookUp(domainsToAge(recent, FREE_MAIL)).catch(() => ({ looked: 0, failed: 1 }))
  const groups = new Map(
    probeMail(items, Number.MAX_SAFE_INTEGER, ages.known()).items.map((group) => [
      groupKey({
        ...(group.from === null ? {} : { from: group.from }),
        ...(group.listId === null ? {} : { listId: group.listId }),
      }),
      group,
    ]),
  )
  // The owner's own: a domain they wrote to anyone at, their own mailbox's domain, or a sender a protect rule keeps.
  const trusted = new Set(
    [address, ...items.filter((item) => item.labels?.includes("Sent")).flatMap((item) => item.headers?.to ?? [])]
      .map((to) => registrableOf(to))
      .filter((domain) => !FREE_MAIL.has(domain)),
  )
  const protectedSenders = new Set(
    items.filter((item) => decide(rules, item)?.protected).flatMap((item) => item.headers?.from?.toLowerCase() ?? []),
  )
  const fraud = (signals: readonly string[]) =>
    signals.reduce(
      (sum, signal) => sum + (FRAUD_SIGNALS.includes(signal as never) ? WEIGHTS[signal as keyof typeof WEIGHTS] : 0),
      0,
    )
  const scores = new Map<string, SenderScore>()
  for (const item of items) {
    const from = item.headers?.from?.toLowerCase()
    const group = item.headers === undefined ? undefined : groups.get(groupKey(item.headers))
    if (from === undefined || group === undefined) continue
    const held = scores.get(from)
    if (held === undefined || group.score > held.score)
      scores.set(from, {
        address: from,
        score: group.score,
        signals: group.signals,
        demoted:
          fraud(group.signals) >= DEMOTE_AT &&
          !group.signals.includes("replied") &&
          !trusted.has(registrableOf(from)) &&
          !protectedSenders.has(from),
      })
  }
  const demoted = [...scores.values()].filter((score) => score.demoted).map(({ address }) => address)
  const written = await store.mail.setSenderScores(stored.id, [...scores.values()], now)
  await store.sync.setSyncState(key, SCORED, JSON.stringify({ version: SCORE_VERSION, at: now, demoted }))
  return { scored: written, ...lookups, demoted: demoted.length }
}

/** Every mail account's senders whose mail search ranks lower, as the last scoring left them. */
export const demotedSenders = async (store: MessageStore): Promise<Set<string>> => {
  const senders = new Set<string>()
  for (const account of await store.accounts.accounts()) {
    if (account.provider !== "email") continue
    const value = (await store.sync.syncState(account, SCORED))?.value
    for (const sender of value === undefined ? [] : ((JSON.parse(value) as { demoted?: string[] }).demoted ?? []))
      senders.add(sender)
  }
  return senders
}
