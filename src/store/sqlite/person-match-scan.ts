import { isEmailAddress } from "../../domain/addresses.js"
import { BARE_INTERNATIONAL_PROVIDERS, storedPhone } from "../../domain/phones.js"
import type { CacheDatabase } from "../driver.js"
import type { IdentityLinkSignal, MatchScan } from "../identity-links.js"
import { type LinkIndex, linkIndex, settleLinks } from "./identity-link-rows.js"
import { type Opening, openIdentityLink } from "./identity-proposals.js"
import type { Author } from "./memories.js"
import type { StoreContext } from "./open.js"
import { mergePerson } from "./person-links.js"
import { personsByIdentifiers } from "./person-matcher.js"
import { resolvePersonLinks } from "./person-resolution.js"
import { separated } from "./person-separation.js"
import { referenceOfThing } from "./things.js"
import { write } from "./transaction.js"

/** Who an automatic link is recorded as: never the owner, whose moves count as separations. */
const BY = "rule"
const RULE: Author = { bot: "rule", kind: "rule" }

/** More people than this on one number or address is a shared line or mailbox: nobody is proposed from it. */
const MOST_SHARING = 6

const CURSOR = "people.scan"

/**
 * NEED-2445, safe option until the owner rules: a number two people share joins them only when a messenger, which
 * keeps its user's own number, holds it; a CRM's or a card's number is someone's word and waits as a proposal.
 */
const phonePairJoins = (holders: Holder[]): boolean =>
  holders.some(({ provider }) => BARE_INTERNATIONAL_PROVIDERS.includes(provider))

/** NEED-2446, safe option until the owner rules: an address more than two people have is shared, so it proposes. */
const addressGroupJoins = (people: number): boolean => people <= 2

interface Holder {
  identity: number
  provider: string
}

/** Identities by the value they share. */
type Holders = Map<string, Holder[]>

/** Where the last pass stopped: every identity, move, revision and meeting guest after it is new to the next one. */
interface Cursor {
  identity: number
  event: number
  revision: number
  participant: number
  at: number
}

const maxOf = (database: CacheDatabase, sql: string): number => Number(database.prepare(sql).get()?.n ?? 0)

const cursorNow = (database: CacheDatabase): Cursor => ({
  identity: maxOf(database, "SELECT max(id) AS n FROM identities"),
  event: maxOf(database, "SELECT max(id) AS n FROM identity_link_events"),
  revision: maxOf(database, "SELECT max(id) AS n FROM identity_revisions"),
  participant: maxOf(database, "SELECT max(id) AS n FROM meeting_participants"),
  at: maxOf(database, "SELECT max(updated_at) AS n FROM identities"),
})

const savedCursor = (database: CacheDatabase): Cursor | undefined => {
  const value = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(CURSOR)?.value
  return value === undefined ? undefined : (JSON.parse(String(value)) as Cursor)
}

/** The identities changed since `since`: new ones, moved ones, edited ones and ones a new meeting guest row names. */
const changedSince = (database: CacheDatabase, since: Cursor): Set<number> =>
  new Set(
    database
      .prepare(
        "SELECT id FROM identities WHERE id > ? OR updated_at > ? " +
          "UNION SELECT identity_id FROM identity_link_events WHERE id > ? " +
          "UNION SELECT identity_id FROM identity_revisions WHERE id > ? " +
          "UNION SELECT identity_id FROM meeting_participants WHERE id > ?",
      )
      .all(since.identity, since.at, since.event, since.revision, since.participant)
      .map(({ id }) => Number(id)),
  )

const add = (found: Holders, key: string | undefined, holder: Holder) => {
  if (key === undefined) return
  const held = found.get(key) ?? []
  if (!held.some(({ identity }) => identity === holder.identity)) held.push(holder)
  found.set(key, held)
}

const phoneHolders = (database: CacheDatabase): Holders => {
  const found: Holders = new Map()
  for (const row of database
    .prepare(
      "SELECT i.id, i.provider, i.external_id, i.phone FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
        "WHERE i.provider = 'phone' OR i.phone IS NOT NULL ORDER BY i.id",
    )
    .all()) {
    const provider = String(row.provider)
    const raw = String(provider === "phone" ? row.external_id : row.phone)
    add(found, storedPhone(raw, provider), { identity: Number(row.id), provider })
  }
  return found
}

const addressOf = (value: unknown): string | undefined => {
  const address = typeof value === "string" ? value.trim().toLowerCase() : ""
  return isEmailAddress(address) ? address : undefined
}

/** A company's address is an `org-email` identity, never a person's, so it never joins people. */
const emailHolders = (database: CacheDatabase): Holders => {
  const found: Holders = new Map()
  for (const row of database
    .prepare(
      "SELECT i.id, i.provider, i.external_id, i.email FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
        "WHERE i.provider <> 'org-email' AND (i.provider = 'email' OR i.email IS NOT NULL) ORDER BY i.id",
    )
    .all()) {
    const holder = { identity: Number(row.id), provider: String(row.provider) }
    add(found, addressOf(row.email), holder)
    if (row.provider === "email") add(found, addressOf(row.external_id), holder)
  }
  return found
}

const personOf = ({ database }: StoreContext, identity: number): number | undefined => {
  const row = database.prepare("SELECT person_id FROM identity_links WHERE identity_id = ?").get(identity)
  return row ? Number(row.person_id) : undefined
}

/** The people the identities are on now, each once, with an identity of each that holds the value. */
const peopleOf = (context: StoreContext, holders: Holder[]): Map<number, number> => {
  const found = new Map<number, number>()
  for (const { identity } of holders) {
    const person = personOf(context, identity)
    if (person !== undefined && !found.has(person)) found.set(person, identity)
  }
  return found
}

const resolveNames = (context: StoreContext, person: number) =>
  resolvePersonLinks(
    context.database,
    context.database
      .prepare(
        "SELECT i.name, i.username FROM identities i JOIN identity_links l ON l.identity_id = i.id WHERE l.person_id = ?",
      )
      .all(person)
      .flatMap((row) => [row.name as string | null, row.username as string | null]),
  )

interface Pass {
  context: StoreContext
  index: LinkIndex
  result: MatchScan
}

/** Joins two people unless the owner separated them or rejected the pair (NEED-2444); gives the person that stays. */
const join = (pass: Pass, from: number, into: number, signal: "same-email" | "same-phone"): number => {
  const { context, index, result } = pass
  const persons = [String(from), String(into)]
  if (separated(context, from, into)) {
    result.skipped.push({ persons, signal, reason: "identity.separated" })
    return into
  }
  if (index.known(from, into)?.status === "rejected") {
    result.skipped.push({ persons, signal, reason: "identity.rejected" })
    return into
  }
  const kept = mergePerson(context, from, into, { method: signal, by: BY })
  index.merged(kept === into ? from : into, kept)
  resolveNames(context, kept)
  result.merged.push({ into: String(kept), from: String(kept === into ? from : into), signal })
  return kept
}

const propose = ({ context, index, result }: Pass, opening: Omit<Opening, "by">) => {
  const opened = openIdentityLink(context, { ...opening, by: RULE }, index)
  const persons: [string, string] = [String(opening.from), String(opening.to)]
  if (opened.outcome === "skipped") {
    if (opened.reason !== "identity.same")
      result.skipped.push({ persons, signal: opening.signal, reason: opened.reason })
    return
  }
  result.proposed.push({ id: opened.action.id, persons, signal: opening.signal, opened: opened.outcome === "proposed" })
}

const proposeEachPair = (pass: Pass, people: Map<number, number>, signal: IdentityLinkSignal) => {
  const persons = [...people.keys()].sort((a, b) => a - b)
  for (const [at, from] of persons.entries())
    for (const to of persons.slice(at + 1))
      propose(pass, {
        identity: people.get(from) as number,
        with: people.get(to) as number,
        from,
        to,
        joins: "person",
        signal,
        candidates: persons,
      })
}

const tooMany = (pass: Pass, people: Map<number, number>, reason: string, signal: string): boolean => {
  if (people.size <= MOST_SHARING) return false
  pass.result.skipped.push({ persons: [...people.keys()].map(String), signal, reason })
  return true
}

/** A number two people have joins them (NEED-2445); one that more share, or that once proposed, proposes. */
const samePhone = (pass: Pass, holders: Holder[]) => {
  const people = peopleOf(pass.context, holders)
  if (people.size < 2 || tooMany(pass, people, "identity.shared-phone", "phone")) return
  const [into, from] = [...people.keys()].sort((a, b) => a - b) as [number, number]
  if (people.size === 2 && phonePairJoins(holders) && pass.index.known(from, into) === undefined)
    join(pass, from, into, "same-phone")
  else proposeEachPair(pass, people, "phone")
}

/** One address is one person in any scope (NEED-2382), unless more than two people have it (NEED-2446). */
const sameEmail = (pass: Pass, holders: Holder[]) => {
  const people = peopleOf(pass.context, holders)
  if (people.size < 2 || tooMany(pass, people, "identity.shared-email", "email")) return
  if (!addressGroupJoins(people.size)) return proposeEachPair(pass, people, "email")
  const contact = holders.find(({ provider }) => provider === "email")
  const held = contact === undefined ? undefined : personOf(pass.context, contact.identity)
  let into = held !== undefined && people.has(held) ? held : [...people.keys()].reduce((a, b) => Math.min(a, b))
  for (const from of people.keys()) if (from !== into) into = join(pass, from, into, "same-email")
}

/** What a meeting guest typed is their word only: it is proposed, and only when it names exactly one person. */
const guestEmail = (pass: Pass, row: { identity: number; email: unknown; meeting: number }) => {
  const { context } = pass
  const address = addressOf(row.email)
  const from = personOf(context, row.identity)
  if (address === undefined || from === undefined) return
  const others = personsByIdentifiers(context.database, { emails: [address], phones: [] }).filter((one) => one !== from)
  if (others.length !== 1) return
  const meeting = referenceOfThing(context.database, { type: "meeting", id: row.meeting })
  propose(pass, {
    identity: row.identity,
    with: null,
    from,
    to: others[0] as number,
    joins: "identity",
    signal: "guest-email",
    ...(meeting === undefined ? {} : { evidence: [meeting] }),
  })
}

const guestRows = (database: CacheDatabase) =>
  database
    .prepare(
      "SELECT mp.identity_id, i.provider, i.external_id, mp.email, min(mp.meeting_id) AS meeting " +
        "FROM meeting_participants mp JOIN identity_links l ON l.identity_id = mp.identity_id " +
        "JOIN identities i ON i.id = mp.identity_id WHERE mp.email IS NOT NULL " +
        "GROUP BY mp.identity_id, lower(trim(mp.email)) ORDER BY mp.identity_id",
    )
    .all()
    .map((row) => ({
      identity: Number(row.identity_id),
      ref: `${String(row.provider)}:${String(row.external_id)}`,
      email: row.email,
      meeting: Number(row.meeting),
    }))

/**
 * One pass of the people matcher. It reads what may match outside any transaction and takes the write lock only for
 * each group it changes, so other writers are never kept waiting for the whole pass. After the first pass, only the
 * values of identities changed since the last one are looked at, unless `full`. The owner's separations and
 * rejections hold throughout.
 */
export const scanMatches = (context: StoreContext, { full = false }: { full?: boolean } = {}): MatchScan => {
  const { database } = context
  const started = cursorNow(database)
  const since = full ? undefined : savedCursor(database)
  const changed = since === undefined ? undefined : changedSince(database, since)
  const touched = (holders: Holder[]) => changed === undefined || holders.some(({ identity }) => changed.has(identity))
  write(database, () => settleLinks(database))
  const pass: Pass = {
    context,
    index: linkIndex(database),
    result: { full: changed === undefined, merged: [], proposed: [], skipped: [] },
  }
  for (const holders of emailHolders(database).values())
    if (holders.length > 1 && touched(holders)) write(database, () => sameEmail(pass, holders))
  for (const holders of phoneHolders(database).values())
    if (holders.length > 1 && touched(holders)) write(database, () => samePhone(pass, holders))
  for (const row of guestRows(database))
    if ((changed === undefined || changed.has(row.identity)) && !pass.index.names(row.ref))
      write(database, () => guestEmail(pass, row))
  write(database, () =>
    database
      .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
      .run(CURSOR, JSON.stringify(started), context.now()),
  )
  return pass.result
}
