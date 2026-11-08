import type { MatchScan } from "../identity-links.js"
import { knownPair, openIdentityLink } from "./identity-proposals.js"
import type { Author } from "./memories.js"
import type { StoreContext } from "./open.js"
import { mergePerson } from "./person-links.js"
import { personsByIdentifiers, storedPhone } from "./person-matcher.js"
import { resolvePersonLinks } from "./person-resolution.js"
import { separated } from "./person-separation.js"
import { referenceOfThing } from "./things.js"
import { write } from "./transaction.js"

/** Who an automatic link is recorded as: never the owner, whose moves count as separations. */
const BY = "rule"
const RULE: Author = { bot: "rule", kind: "rule" }

/** More people than this on one number is a shared line, a switchboard or a shop: nobody is proposed from it. */
const MOST_ON_ONE_PHONE = 6

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

/** Identities by the value they share, each with the person it is on when the pass reads it. */
type Holders = Map<string, number[]>

const add = (found: Holders, key: string | undefined, identity: number) => {
  if (key === undefined) return
  const held = found.get(key) ?? []
  if (!held.includes(identity)) held.push(identity)
  found.set(key, held)
}

const phoneHolders = ({ database }: StoreContext): Holders => {
  const found: Holders = new Map()
  for (const row of database
    .prepare(
      "SELECT i.id, i.provider, i.external_id, i.phone FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
        "WHERE i.provider = 'phone' OR i.phone IS NOT NULL ORDER BY i.id",
    )
    .all()) {
    add(found, storedPhone(String(row.provider === "phone" ? row.external_id : row.phone)), Number(row.id))
  }
  return found
}

const addressOf = (value: unknown): string | undefined => {
  const address = typeof value === "string" ? value.trim().toLowerCase() : ""
  return ADDRESS.test(address) ? address : undefined
}

/** A company's address is an `org-email` identity, never a person's, so it never joins people. */
const emailHolders = ({ database }: StoreContext): Holders => {
  const found: Holders = new Map()
  for (const row of database
    .prepare(
      "SELECT i.id, i.provider, i.external_id, i.email FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
        "WHERE i.provider <> 'org-email' AND (i.provider = 'email' OR i.email IS NOT NULL) ORDER BY i.id",
    )
    .all()) {
    add(found, addressOf(row.email), Number(row.id))
    if (row.provider === "email") add(found, addressOf(row.external_id), Number(row.id))
  }
  return found
}

const personOf = ({ database }: StoreContext, identity: number): number =>
  Number(database.prepare("SELECT person_id FROM identity_links WHERE identity_id = ?").get(identity)?.person_id)

/** The people the identities are on now, each once, with an identity of each that holds the value. */
const peopleOf = (context: StoreContext, identities: number[]): Map<number, number> => {
  const found = new Map<number, number>()
  for (const identity of identities) {
    const person = personOf(context, identity)
    if (!found.has(person)) found.set(person, identity)
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

const isOwner = ({ database }: StoreContext, person: number): boolean =>
  Number(database.prepare("SELECT owner FROM persons WHERE id = ?").get(person)?.owner) === 1

/** The owner's person is never merged away: anyone who joins them comes to them. */
const join = (
  context: StoreContext,
  result: MatchScan,
  one: number,
  other: number,
  signal: "same-email" | "same-phone",
): void => {
  const [from, into] = isOwner(context, one) ? [other, one] : [one, other]
  if (separated(context, from, into)) {
    result.skipped.push({ persons: [String(from), String(into)], signal, reason: "identity.separated" })
    return
  }
  mergePerson(context, from, into, { method: signal, by: BY })
  resolveNames(context, into)
  result.merged.push({ into: String(into), from: String(from), signal })
}

/** One address, any scope, is one person (NEED-2382): everyone on it joins the one its mail contact is on. */
const sameEmail = (context: StoreContext, result: MatchScan) => {
  const { database } = context
  for (const [address, identities] of emailHolders(context)) {
    const people = peopleOf(context, identities)
    if (people.size < 2) continue
    const contact = database
      .prepare("SELECT id FROM identities WHERE provider = 'email' AND (external_id = ? OR email = ?) LIMIT 1")
      .get(address, address)
    const held = contact ? personOf(context, Number(contact.id)) : undefined
    const owner = [...people.keys()].find((person) => isOwner(context, person))
    const into =
      owner ?? (held !== undefined && people.has(held) ? held : [...people.keys()].reduce((a, b) => Math.min(a, b)))
    for (const from of people.keys()) if (from !== into) join(context, result, from, into, "same-email")
  }
}

/** A number exactly two people have joins them; more than two become proposals between each pair (NEED-2404 A). */
const samePhone = (context: StoreContext, result: MatchScan) => {
  for (const identities of phoneHolders(context).values()) {
    const people = peopleOf(context, identities)
    if (people.size < 2) continue
    const persons = [...people.keys()].sort((a, b) => a - b)
    if (persons.length > MOST_ON_ONE_PHONE) {
      result.skipped.push({ persons: persons.map(String), signal: "phone", reason: "identity.shared-phone" })
      continue
    }
    if (persons.length === 2) {
      const [into, from] = persons as [number, number]
      if (knownPair(context, from, into)?.status === "rejected")
        result.skipped.push({
          persons: [String(from), String(into)],
          signal: "same-phone",
          reason: "identity.rejected",
        })
      else join(context, result, from, into, "same-phone")
      continue
    }
    for (const [index, from] of persons.entries())
      for (const to of persons.slice(index + 1))
        propose(context, result, {
          identity: people.get(from) as number,
          with: people.get(to) as number,
          from,
          to,
          joins: "person",
          signal: "phone",
          by: RULE,
          candidates: persons,
        })
  }
}

const propose = (context: StoreContext, result: MatchScan, opening: Parameters<typeof openIdentityLink>[1]) => {
  const opened = openIdentityLink(context, opening)
  const persons: [string, string] = [String(opening.from), String(opening.to)]
  if (opened.outcome === "skipped") {
    if (opened.reason !== "identity.same")
      result.skipped.push({ persons, signal: opening.signal, reason: opened.reason })
    return
  }
  result.proposed.push({ id: opened.action.id, persons, signal: opening.signal, opened: opened.outcome === "proposed" })
}

/** What a meeting guest typed is their word only: it is proposed, and only when it names exactly one person. */
const guestEmail = (context: StoreContext, result: MatchScan) => {
  const { database } = context
  for (const row of database
    .prepare(
      "SELECT mp.identity_id, mp.email, min(mp.meeting_id) AS meeting FROM meeting_participants mp " +
        "JOIN identity_links l ON l.identity_id = mp.identity_id WHERE mp.email IS NOT NULL " +
        "GROUP BY mp.identity_id, lower(trim(mp.email)) ORDER BY mp.identity_id",
    )
    .all()) {
    const address = addressOf(row.email)
    if (address === undefined) continue
    const identity = Number(row.identity_id)
    const from = personOf(context, identity)
    const others = personsByIdentifiers(database, { emails: [address], phones: [] }).filter((one) => one !== from)
    if (others.length !== 1) continue
    const to = others[0] as number
    const meeting = referenceOfThing(database, { type: "meeting", id: Number(row.meeting) })
    propose(context, result, {
      identity,
      with: null,
      from,
      to,
      joins: "identity",
      signal: "guest-email",
      by: RULE,
      ...(meeting === undefined ? {} : { evidence: [meeting] }),
    })
  }
}

/**
 * One pass of the people matcher over the whole store: the same address joins people, a number two people share
 * joins them, and a shared number among more, or a meeting guest's typed address, becomes a proposal. The owner's
 * separations and rejections hold throughout.
 */
export const scanMatches = (context: StoreContext): MatchScan =>
  write(context.database, () => {
    const result: MatchScan = { merged: [], proposed: [], skipped: [] }
    sameEmail(context, result)
    samePhone(context, result)
    guestEmail(context, result)
    return result
  })
