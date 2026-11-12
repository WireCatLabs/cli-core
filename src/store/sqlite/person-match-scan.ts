import { isEmailAddress, isNoReplyAddress, isPersonLikeRoleAddress, isRoleAddress } from "../../domain/addresses.js"
import { displayName, isReadable } from "../../domain/display-names.js"
import { variantKey } from "../../domain/name-variants.js"
import { BARE_INTERNATIONAL_PROVIDERS, isMobilePhone, storedPhone } from "../../domain/phones.js"
import type { CacheDatabase } from "../driver.js"
import type { IdentityLinkSignal, MatchScan, SharedMailbox } from "../identity-links.js"
import { type LinkIndex, linkIndex, settleLinks } from "./identity-link-rows.js"
import { type Opening, openIdentityLink } from "./identity-proposals.js"
import type { Author } from "./memories.js"
import { peopleByNameKey, type SharedTrace, sharedTraces } from "./name-traces.js"
import type { StoreContext } from "./open.js"
import { isOwner, mergePerson } from "./person-links.js"
import { personsByIdentifiers } from "./person-matcher.js"
import { resolvePersonLinks } from "./person-resolution.js"
import { separated } from "./person-separation.js"
import { referenceOfThing } from "./things.js"
import { write } from "./transaction.js"

/** Who an automatic link is recorded as: never the owner, whose moves count as separations. */
const BY = "rule"
export const RULE: Author = { bot: "rule", kind: "rule" }

/** More people than this on one number or address is a shared line or mailbox: nobody is proposed from it. */
const MOST_SHARING = 6

const CURSOR = "people.scan"

/** Raised when a rule changes what a pass finds in values nobody touched: the next pass then reads everything once. */
const RULES = 5

/**
 * NEED-2526: a shared mailbox says little alone, so its proposal is scored by what else the two people have in common.
 * The owner's word (2026-11-11): `hr@` is often one person's, so it starts below `info@`.
 */
const SHARED_SCORE = { alone: 0.1, personLike: 0.05, name: 0.4, trace: 0.3, weakTrace: 0.2 }

/**
 * NEED-2529: every rule's proposal on the scale of `SHARED_SCORE`, so the review lists the strongest first. A phone two
 * people alone have but that does not join (a CRM's or a card's), one name with a phone or an address only these two
 * hold, and a pair the owner rejected that meets new evidence of that kind are 0.7; one name with a chat or a company
 * domain in one source, and a meeting guest's typed address, 0.5; a phone or personal address 3–6 people share, 0.4;
 * one name alone, written in private chats the owner answers on two messengers, 0.3.
 */
export const PROPOSAL_SCORE = {
  ownPhone: 0.7,
  nameAndOwnTrace: 0.7,
  newEvidence: 0.7,
  nameAndPlace: 0.5,
  guestEmail: 0.5,
  group: 0.4,
  nameInChats: 0.3,
}

/**
 * NEED-2445, safe option until the owner rules: a number two people share joins them only when a messenger, which
 * keeps its user's own number, holds it; a CRM's or a card's number is someone's word and waits as a proposal.
 * NEED-2600: a call's other side, kept as `phone:<number>`, is that number as the phone network gave it, as strong
 * as a messenger's; it joins only on a mobile number, since an office's landline is everyone's who works there.
 */
const phonePairJoins = (phone: string, holders: Holder[]): boolean =>
  holders.some(({ provider }) => BARE_INTERNATIONAL_PROVIDERS.includes(provider)) ||
  (holders.some(({ externalId }) => externalId === `phone:${phone}`) && isMobilePhone(phone))

/** NEED-2446, safe option until the owner rules: an address more than two people have is shared, so it proposes. */
const addressGroupJoins = (people: number): boolean => people <= 2

interface Holder {
  identity: number
  provider: string
  externalId: string
  /** The list it comes from: its source, and for a CRM the kind of record, `<portal>/contact/` or `<portal>/user/`. */
  list: string
  /** An organization holds this identity: its number or address is the company's. */
  company: boolean
}

/** A bot or a service account shares its number or address with whoever runs it; it is nobody's person. */
const NOT_A_BOT = "i.bot IS NOT 1 AND i.provider NOT LIKE '%-bot'"
const COMPANY = "EXISTS (SELECT 1 FROM organization_identities o WHERE o.identity_id = i.id) AS company"

/**
 * SEC-177: a company's line or mailbox is everyone's who works there, so it never says two people are one. It is one
 * when an organization holds it, or when two people of one list have it, such as two CRM contacts with one number. A
 * CRM's contact and its user may be one person, so they are two lists. A messenger keeps one account per number, so
 * two of its accounts on one number are a number that changed hands, not a company's line.
 */
const sharedLine = (context: StoreContext, holders: Holder[]): boolean => {
  if (holders.some(({ company }) => company)) return true
  const seen = new Map<string, number>()
  for (const { identity, provider, list } of holders) {
    if (provider === "email" || provider === "phone" || BARE_INTERNATIONAL_PROVIDERS.includes(provider)) continue
    const person = personOf(context, identity)
    const before = seen.get(list)
    if (before !== undefined && person !== undefined && before !== person) return true
    if (person !== undefined) seen.set(list, person)
  }
  return false
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
  rules?: number
}

const maxOf = (database: CacheDatabase, sql: string): number => Number(database.prepare(sql).get()?.n ?? 0)

const cursorNow = (database: CacheDatabase): Cursor => ({
  identity: maxOf(database, "SELECT max(id) AS n FROM identities"),
  event: maxOf(database, "SELECT max(id) AS n FROM identity_link_events"),
  revision: maxOf(database, "SELECT max(id) AS n FROM identity_revisions"),
  participant: maxOf(database, "SELECT max(id) AS n FROM meeting_participants"),
  at: maxOf(database, "SELECT max(updated_at) AS n FROM identities"),
  rules: RULES,
})

const savedCursor = (database: CacheDatabase): Cursor | undefined => {
  const value = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(CURSOR)?.value
  const cursor = value === undefined ? undefined : (JSON.parse(String(value)) as Cursor)
  return cursor?.rules === RULES ? cursor : undefined
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

const holderOf = (row: Record<string, unknown>): Holder => {
  const provider = String(row.provider)
  return {
    identity: Number(row.id),
    provider,
    externalId: String(row.external_id),
    list: `${provider}:${String(row.external_id).replace(/[^/]*$/u, "")}`,
    company: row.company === 1,
  }
}

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
      `SELECT i.id, i.provider, i.external_id, i.phone, ${COMPANY} FROM identities i ` +
        `JOIN identity_links l ON l.identity_id = i.id WHERE (i.provider = 'phone' OR i.phone IS NOT NULL) AND ${NOT_A_BOT} ` +
        "ORDER BY i.id",
    )
    .all()) {
    const provider = String(row.provider)
    const raw = String(provider === "phone" ? row.external_id : row.phone)
    add(found, storedPhone(raw, provider), holderOf(row))
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
      `SELECT i.id, i.provider, i.external_id, i.email, ${COMPANY} FROM identities i ` +
        "JOIN identity_links l ON l.identity_id = i.id " +
        `WHERE i.provider <> 'org-email' AND (i.provider = 'email' OR i.email IS NOT NULL) AND ${NOT_A_BOT} ORDER BY i.id`,
    )
    .all()) {
    const holder = holderOf(row)
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

interface SharedGroup {
  address: string
  holders: Holder[]
  shared: SharedMailbox
}

interface Pass {
  context: StoreContext
  index: LinkIndex
  result: MatchScan
  /** Shared mailboxes, proposed after the phones: an open proposal would keep a phone from joining the pair. */
  shared: SharedGroup[]
}

/**
 * Joins two people unless the owner separated them, or rejected the pair (NEED-2444): then the pair is proposed when
 * this evidence is new to the owner. Gives the person that stays.
 */
const join = (
  pass: Pass,
  sides: { from: number; into: number; identity: number; with: number },
  signal: "email" | "phone",
): number => {
  const { context, index, result } = pass
  const { from, into } = sides
  const method = signal === "email" ? "same-email" : "same-phone"
  if (separated(context, from, into)) {
    result.skipped.push({ persons: [String(from), String(into)], signal: method, reason: "identity.separated" })
    return into
  }
  if (touchesOwner(pass, from, into, method)) return into
  if (index.rejected(from, into) !== undefined) {
    propose(pass, {
      identity: sides.identity,
      with: sides.with,
      from,
      to: into,
      joins: "person",
      signal,
      score: PROPOSAL_SCORE.newEvidence,
    })
    return into
  }
  const kept = mergePerson(context, from, into, { method, by: BY })
  index.merged(kept === into ? from : into, kept)
  resolveNames(context, kept)
  result.merged.push({ into: String(kept), from: String(kept === into ? from : into), signal: method })
  return kept
}

/**
 * SEC-177: the scan never joins the owner or proposes anyone to them; a mailbox or number the owner reads may be
 * someone else's, and only the owner joins anyone to themselves.
 */
const touchesOwner = ({ context, result }: Pass, from: number, to: number, signal: string): boolean => {
  if (!isOwner(context, from) && !isOwner(context, to)) return false
  result.skipped.push({ persons: [String(from), String(to)], signal, reason: "identity.owner" })
  return true
}

const propose = (pass: Pass, opening: Omit<Opening, "by">) => {
  const { context, index, result } = pass
  if (touchesOwner(pass, opening.from, opening.to, opening.signal)) return
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
  const score = people.size === 2 ? PROPOSAL_SCORE.ownPhone : PROPOSAL_SCORE.group
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
        score,
      })
}

const tooMany = (pass: Pass, people: Map<number, number>, reason: string, signal: string): boolean => {
  if (people.size <= MOST_SHARING) return false
  pass.result.skipped.push({ persons: [...people.keys()].map(String), signal, reason })
  return true
}

const skipShared = (pass: Pass, people: Map<number, number>, signal: string) =>
  pass.result.skipped.push({ persons: [...people.keys()].map(String), signal, reason: `identity.shared-${signal}` })

/**
 * A number two people have joins them (NEED-2445); one that more share, or that once proposed, proposes. A company's
 * line does neither.
 */
const samePhone = (pass: Pass, phone: string, holders: Holder[]) => {
  const people = peopleOf(pass.context, holders)
  if (people.size < 2 || tooMany(pass, people, "identity.shared-phone", "phone")) return
  if (sharedLine(pass.context, holders)) return skipShared(pass, people, "phone")
  const [into, from] = [...people.keys()].sort((a, b) => a - b) as [number, number]
  if (people.size === 2 && phonePairJoins(phone, holders) && !pass.index.known(from, into))
    join(pass, { from, into, identity: people.get(from) as number, with: people.get(into) as number }, "phone")
  else proposeEachPair(pass, people, "phone")
}

const nameOf = ({ database }: StoreContext, person: number): string | null => {
  const name = database.prepare("SELECT name FROM persons WHERE id = ?").get(person)?.name
  return typeof name === "string" ? name : null
}

const TRACE_WORDS: Record<SharedTrace["kind"], string> = {
  phone: "the same phone",
  email: "another address only they have",
  chat: "a chat they are both in",
  "email-domain": "mail at the same company",
  "crm-company": "the same company in the CRM",
}

/** What two people on one shared mailbox have in common besides it, as a score and the words that say why. */
const sharedMailboxCase = (context: StoreContext, address: string, from: number, to: number) => {
  const reasons = [`both have the shared mailbox ${address}`]
  let score = isPersonLikeRoleAddress(address) ? SHARED_SCORE.personLike : SHARED_SCORE.alone
  const name = nameOf(context, from)
  const key = variantKey(name)
  if (key !== null && key === variantKey(nameOf(context, to))) {
    score += SHARED_SCORE.name
    reasons.push(`the same name «${name}»`)
  }
  let evidence: string[] = []
  for (const trace of sharedTraces(context.database, from, to, name ?? "", address))
    if (!(trace.kind === "email" && isRoleAddress(trace.value ?? "")) && strongEnough(context, from, to, trace)) {
      score += trace.value === undefined ? SHARED_SCORE.weakTrace : SHARED_SCORE.trace
      reasons.push(TRACE_WORDS[trace.kind])
      evidence = trace.evidence
      break
    }
  return { score: Math.round(score * 100) / 100, reason: reasons.join("; "), evidence }
}

/**
 * NEED-2526: a shared mailbox never joins anyone (SEC-177), but each pair on it is proposed to the owner, scored by
 * what else they share.
 */
const proposeShared = (pass: Pass, { address, holders, shared }: SharedGroup) => {
  const people = peopleOf(pass.context, holders)
  if (people.size < 2) return
  const persons = [...people.keys()].sort((a, b) => a - b)
  for (const [at, from] of persons.entries())
    for (const to of persons.slice(at + 1))
      propose(pass, {
        identity: people.get(from) as number,
        with: people.get(to) as number,
        from,
        to,
        joins: "person",
        signal: "email",
        candidates: persons,
        shared,
        mailbox: address,
        ...sharedMailboxCase(pass.context, address, from, to),
      })
}

/**
 * One address is one person in any scope (NEED-2382), unless more than two people have it (NEED-2446). A no-reply
 * address is no one's. A role address such as `info@` and a company's mailbox only propose (NEED-2526).
 */
const sameEmail = (pass: Pass, address: string, holders: Holder[]) => {
  if (isNoReplyAddress(address)) return
  const people = peopleOf(pass.context, holders)
  if (people.size < 2 || tooMany(pass, people, "identity.shared-email", "email")) return
  const role = isRoleAddress(address)
  if (role || sharedLine(pass.context, holders)) {
    pass.shared.push({ address, holders, shared: role ? "role" : "line" })
    return
  }
  if (!addressGroupJoins(people.size)) return proposeEachPair(pass, people, "email")
  const contact = holders.find(({ provider }) => provider === "email")
  const held = contact === undefined ? undefined : personOf(pass.context, contact.identity)
  let into = held !== undefined && people.has(held) ? held : [...people.keys()].reduce((a, b) => Math.min(a, b))
  // The mail contact stands for its person, as at import, so both paths name the same evidence to the owner.
  const intoIdentity = contact !== undefined && held === into ? contact.identity : (people.get(into) as number)
  for (const from of people.keys())
    if (from !== into)
      into = join(pass, { from, into, identity: people.get(from) as number, with: intoIdentity }, "email")
}

const peopleOfIdentities = (context: StoreContext, identities: Set<number>): Set<number> =>
  new Set([...identities].flatMap((identity) => personOf(context, identity) ?? []))

const providersOf = ({ database }: StoreContext, person: number): Set<string> =>
  new Set(
    database
      .prepare(
        "SELECT DISTINCT i.provider FROM identity_links l JOIN identities i ON i.id = l.identity_id WHERE l.person_id = ?",
      )
      .all(person)
      .map(({ provider }) => String(provider)),
  )

/**
 * SEC-177: a phone or address proves only when it is these two people's alone. A chat or a company's domain is weaker,
 * and is enough only between people of one source, whose names come from one place.
 */
const strongEnough = (context: StoreContext, from: number, to: number, trace: SharedTrace): boolean => {
  if (trace.value !== undefined) {
    const held = personsByIdentifiers(context.database, {
      emails: trace.kind === "email" ? [trace.value] : [],
      phones: trace.kind === "phone" ? [trace.value] : [],
    })
    return held.every((person) => person === from || person === to)
  }
  const theirs = providersOf(context, to)
  return [...providersOf(context, from)].some((provider) => theirs.has(provider))
}

/**
 * One name and a shared trace (a phone, an address, a chat, a company's domain) only proposes: a name is common, so
 * the owner decides every merge. More than `MOST_SHARING` people on one name is too common to propose from.
 */
const sameName = (pass: Pass, people: number[], name: string) => {
  if (people.length > MOST_SHARING) {
    pass.result.skipped.push({ persons: people.map(String), signal: "name", reason: "identity.common-name" })
    return
  }
  const sorted = [...people].sort((a, b) => a - b)
  for (const [at, from] of sorted.entries())
    for (const to of sorted.slice(at + 1)) {
      let trace: SharedTrace | undefined
      for (const one of sharedTraces(pass.context.database, from, to, name))
        if (strongEnough(pass.context, from, to, one)) {
          trace = one
          break
        }
      if (trace === undefined) continue
      propose(pass, {
        identity: trace.identity,
        with: trace.with,
        from,
        to,
        joins: "person",
        signal: "name",
        score: trace.value === undefined ? PROPOSAL_SCORE.nameAndPlace : PROPOSAL_SCORE.nameAndOwnTrace,
        evidence: trace.evidence,
        reason: trace.reason,
      })
    }
}

/**
 * The identities that wrote in a private chat the owner wrote in too, by the name they write under. A messenger may
 * hide the phone (a WhatsApp `@lid`), so one name on two messengers, each a conversation, is all there is to go on.
 */
const chatNames = (database: CacheDatabase): Map<string, { identity: number; provider: string; name: string }[]> => {
  const found = new Map<string, { identity: number; provider: string; name: string }[]>()
  for (const row of database
    .prepare(
      "SELECT DISTINCT i.id, i.provider, i.name FROM messages s JOIN identities i ON i.id = s.sender_identity_id " +
        "JOIN identity_links l ON l.identity_id = i.id WHERE s.outgoing IS NOT 1 AND i.bot IS NOT 1 " +
        "AND trim(coalesce(i.name, '')) <> '' AND s.chat_id IN (SELECT c.id FROM chats c WHERE c.kind = 'dialog' " +
        "AND EXISTS (SELECT 1 FROM messages o WHERE o.chat_id = c.id AND o.outgoing = 1)) ORDER BY i.id",
    )
    .all()) {
    const name = String(row.name).trim()
    const key = name.toLocaleLowerCase()
    const held = found.get(key) ?? []
    held.push({ identity: Number(row.id), provider: String(row.provider), name })
    found.set(key, held)
  }
  return found
}

/** One name on two messengers, each a private conversation, and nothing else: the owner decides (`nameInChats`). */
const sameNameInChats = (pass: Pass, holders: { identity: number; provider: string; name: string }[]) => {
  const people = new Map<number, { identity: number; provider: string; name: string }>()
  for (const holder of holders) {
    const person = personOf(pass.context, holder.identity)
    if (person !== undefined && !people.has(person)) people.set(person, holder)
  }
  if (people.size < 2) return
  if (people.size > MOST_SHARING) {
    pass.result.skipped.push({
      persons: [...people.keys()].map(String),
      signal: "name",
      reason: "identity.common-name",
    })
    return
  }
  const persons = [...people.keys()].sort((a, b) => a - b)
  for (const [at, from] of persons.entries())
    for (const to of persons.slice(at + 1)) {
      const [one, other] = [people.get(from), people.get(to)] as { identity: number; provider: string; name: string }[]
      if (one === undefined || other === undefined || one.provider === other.provider) continue
      propose(pass, {
        identity: one.identity,
        with: other.identity,
        from,
        to,
        joins: "person",
        signal: "name",
        score: PROPOSAL_SCORE.nameInChats,
        reason: `same name «${one.name}» in private chats on ${one.provider} and ${other.provider}`,
      })
    }
}

/**
 * The person an identity of one of the owner's own accounts sits on (a second profile they use) is named after that
 * profile's label: their own name from their other identities is better, the fullest one first.
 */
const renameFromOwnAccounts = ({ database, now }: StoreContext): void => {
  const named = database
    .prepare(
      "SELECT DISTINCT p.id FROM persons p JOIN identity_links l ON l.person_id = p.id " +
        "JOIN identities i ON i.id = l.identity_id JOIN accounts a ON a.provider = i.provider " +
        "AND a.external_id = i.external_id WHERE p.owner = 0 AND p.name = i.name",
    )
    .all()
  for (const { id } of named) {
    const names = database
      .prepare(
        "SELECT i.name FROM identity_links l JOIN identities i ON i.id = l.identity_id WHERE l.person_id = ? " +
          "AND trim(coalesce(i.name, '')) <> '' AND NOT EXISTS (SELECT 1 FROM accounts a " +
          "WHERE a.provider = i.provider AND a.external_id = i.external_id) ORDER BY i.id",
      )
      .all(Number(id))
      .map((row) => String(row.name).trim())
      .filter((name) => isReadable(displayName(name)) && !name.startsWith("@"))
    const words = (name: string) => name.split(/\s+/u).length
    const fullest = names.reduce<string | undefined>(
      (best, name) =>
        best === undefined || words(name) > words(best) || (words(name) === words(best) && name.length > best.length)
          ? name
          : best,
      undefined,
    )
    if (fullest !== undefined)
      database.prepare("UPDATE persons SET name = ?, updated_at = ? WHERE id = ?").run(fullest, now(), Number(id))
  }
}

/** What a meeting guest typed is their word only: it is proposed, and only when it names exactly one person. */
const guestEmail = (pass: Pass, row: { identity: number; email: unknown; meeting: number }) => {
  const { context } = pass
  const address = addressOf(row.email)
  const from = personOf(context, row.identity)
  if (address === undefined || from === undefined || isNoReplyAddress(address)) return
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
    score: PROPOSAL_SCORE.guestEmail,
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
    shared: [],
  }
  for (const [address, holders] of emailHolders(database))
    if (holders.length > 1 && touched(holders)) write(database, () => sameEmail(pass, address, holders))
  for (const [phone, holders] of phoneHolders(database))
    if (holders.length > 1 && touched(holders)) write(database, () => samePhone(pass, phone, holders))
  for (const group of pass.shared) write(database, () => proposeShared(pass, group))
  for (const row of guestRows(database))
    if ((changed === undefined || changed.has(row.identity)) && !pass.index.names(row.ref))
      write(database, () => guestEmail(pass, row))
  const changedPeople = changed === undefined ? undefined : peopleOfIdentities(context, changed)
  for (const { people, name } of peopleByNameKey(database).values())
    if (people.length > 1 && (changedPeople === undefined || people.some((one) => changedPeople.has(one))))
      write(database, () => sameName(pass, people, name))
  for (const holders of chatNames(database).values())
    if (holders.length > 1 && (changed === undefined || holders.some(({ identity }) => changed.has(identity))))
      write(database, () => sameNameInChats(pass, holders))
  write(database, () => renameFromOwnAccounts(context))
  write(database, () =>
    database
      .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
      .run(CURSOR, JSON.stringify(started), context.now()),
  )
  return pass.result
}
