import { CliError } from "@wirecat/cli-base"
import { displayName } from "../../domain/display-names.js"
import { nameSkeletons } from "../../domain/name-variants.js"
import { RESERVED_ADDRESS_GLOBS, SEED_ID_GLOBS, SEED_PEOPLE } from "../../domain/test-data.js"
import type { CacheDatabase } from "../driver.js"
import { keptTogether } from "./identity-split-proposals.js"
import type { StoreContext } from "./open.js"
import { merges } from "./person-merges.js"

/** Why a person may be wrong, most urgent first: the owner's own person holding someone else matters most. */
export const DOUBT_REASONS = ["owner-other-name", "test-data", "shared-address", "mixed-names"] as const

export type DoubtReason = (typeof DOUBT_REASONS)[number]

export interface DoubtIdentity {
  identity: string
  name: string | null
  /** How the identity came to this person, and who linked it. */
  method: string
  by: string
  at: string
}

export interface PersonDoubt {
  person: string
  name: string | null
  owner: boolean
  reason: DoubtReason
  /** The reason in plain words, naming what was found. */
  why: string
  /** The identities in doubt, not every identity of the person. */
  identities: DoubtIdentity[]
  /** What the doubt rests on: the identities, a shared address, the merges that brought them. */
  evidence: string[]
  /** memo commands, after `memo`, that would take the doubted identities off; empty when none fits. */
  fix: string[]
  /** The same moves as `fix`, one each, for an app that runs them without a command line. */
  moves: DoubtMove[]
}

/** Undo a merge, or move identities to one new person. */
export type DoubtMove = { op: "unmerge"; merge: string } | { op: "unlink"; identities: string[] }

export interface PersonDoubts {
  items: PersonDoubt[]
  total: number
  hasMore: boolean
}

interface Held {
  pk: number
  person: number
  owner: boolean
  personName: string | null
  ref: string
  name: string | null
  phone: string | null
  email: string | null
  /** The identity is an account the owner connected. */
  account: boolean
  method: string
  by: string
  at: number
}

const COLUMNS =
  "l.person_id AS person, p.owner, p.name AS person_name, i.id AS pk, i.provider, i.external_id, i.name, i.phone, " +
  "i.email, l.method, l.author, l.created_at, EXISTS (SELECT 1 FROM accounts a WHERE a.provider = i.provider " +
  "AND a.external_id = i.external_id) AS account FROM identity_links l JOIN identities i ON i.id = l.identity_id " +
  "JOIN persons p ON p.id = l.person_id"

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null)

const heldOf = (row: Record<string, unknown>): Held => ({
  pk: Number(row.pk),
  person: Number(row.person),
  owner: Number(row.owner) === 1,
  personName: text(row.person_name),
  ref: `${String(row.provider)}:${String(row.external_id)}`,
  name: text(row.name),
  phone: text(row.phone)?.replace(/\D/gu, "") || null,
  email: text(row.email)?.toLowerCase() ?? null,
  account: Number(row.account) === 1,
  method: String(row.method),
  by: String(row.author),
  at: Number(row.created_at),
})

/** Only these people can carry two names or someone else's identity; the store has a few thousand of them. */
const sharedPeople = (database: CacheDatabase): Held[] =>
  database
    .prepare(
      `SELECT ${COLUMNS} WHERE l.person_id IN (SELECT person_id FROM identity_links GROUP BY person_id HAVING count(*) > 1) ` +
        "ORDER BY l.person_id, i.id",
    )
    .all()
    .map(heldOf)

/**
 * Identities a test run left: the seed's word ids, an address at a reserved domain, or a seed name with its username
 * or beside another seed name in one provider, since one name alone may be a real person's.
 */
const testData = (database: CacheDatabase): Held[] => {
  const names = JSON.stringify(SEED_PEOPLE.map(({ name }) => name))
  const usernames = JSON.stringify(SEED_PEOPLE.flatMap(({ username }) => (username === null ? [] : [username])))
  const globs = (column: string, patterns: readonly string[]) =>
    patterns.map((pattern) => `${column} GLOB '${pattern}'`).join(" OR ")
  return database
    .prepare(
      `SELECT ${COLUMNS} WHERE ${globs("i.external_id", SEED_ID_GLOBS)} OR ${globs("lower(i.email)", RESERVED_ADDRESS_GLOBS)} ` +
        "OR (i.name IN (SELECT value FROM json_each(?)) AND (i.username IN (SELECT value FROM json_each(?)) " +
        "OR (SELECT count(DISTINCT j.name) FROM identities j WHERE j.provider = i.provider " +
        "AND j.name IN (SELECT value FROM json_each(?))) >= 2)) ORDER BY l.person_id, i.id",
    )
    .all(names, usernames, names)
    .map(heldOf)
}

/** A name's words, script and spelling aside; none for an address or a placeholder, which say nothing of a name. */
const wordsOf = (name: string | null): Set<string> => {
  const shown = displayName(name)
  if (shown === null || shown.includes("@")) return new Set()
  return new Set(nameSkeletons(shown).filter((word) => word.length >= 2 && !/^\d+$/u.test(word)))
}

const sharesWord = (one: Set<string>, other: Set<string>): boolean => [...one].some((word) => other.has(word))

/**
 * The identities grouped by names that share a word, the person's own first: the most identities, counting double what
 * the owner linked by hand, an account the owner connected and the person's own name.
 */
const nameGroups = (held: Held[]): Held[][] => {
  const named = held.map((one) => ({ one, words: wordsOf(one.name) })).filter(({ words }) => words.size > 0)
  const group = named.map((_, index) => index)
  const root = (at: number): number => {
    let top = at
    while (group[top] !== top) top = group[top] as number
    let step = at
    while (group[step] !== top) {
      const next = group[step] as number
      group[step] = top
      step = next
    }
    return top
  }
  const firstWith = new Map<string, number>()
  for (const [index, { words }] of named.entries())
    for (const word of words) {
      const first = firstWith.get(word)
      if (first === undefined) firstWith.set(word, index)
      else group[root(index)] = root(first)
    }
  const groups = new Map<number, Held[]>()
  for (const [index, { one }] of named.entries()) {
    const same = groups.get(root(index))
    if (same) same.push(one)
    else groups.set(root(index), [one])
  }
  const own = wordsOf(held[0]?.personName ?? null)
  const weight = (members: Held[]) =>
    members.reduce((sum, one) => sum + 1 + (one.by === "owner" ? 2 : 0) + (one.account ? 2 : 0), 0) +
    (members.some(({ name }) => sharesWord(wordsOf(name), own)) ? 2 : 0)
  return [...groups.values()].sort((a, b) => weight(b) - weight(a) || (a[0] as Held).pk - (b[0] as Held).pk)
}

interface Found {
  person: number
  owner: boolean
  name: string | null
  reason: DoubtReason
  held: Held[]
  /** A shared address, for `shared-address`. */
  address?: string
}

const quoted = (held: Held[]): string =>
  [...new Set(held.map(({ name, ref }) => name ?? ref))].map((name) => `«${name}»`).join(", ")

const whyOf = (found: Found): string => {
  const names = quoted(found.held)
  if (found.reason === "owner-other-name")
    return `your own person holds ${names}, under another name than yours: an account or mailbox you read may be someone else's`
  if (found.reason === "test-data")
    return `${names} looks like test data, not a real contact: a name from the test seed, or an address at a reserved test domain`
  if (found.reason === "shared-address")
    return `${names} joined this person by the address ${found.address}, which people with other names share: a shared or company mailbox may hold two people`
  return `this person carries different names (${names}) with no phone or address in common`
}

const doubtsOf = (held: Held[], kept: ReadonlySet<string>, test: ReadonlySet<number>): Found[] => {
  const [first] = held
  if (first === undefined) return []
  const groups = nameGroups(held.filter(({ pk }) => !test.has(pk)))
  if (groups.length < 2) return []
  const main = groups[0] as Held[]
  const outside = groups
    .slice(1)
    .flat()
    .filter(({ by, ref }) => by !== "owner" && !kept.has(ref))
  const base = { person: first.person, owner: first.owner, name: first.personName }
  if (first.owner) return outside.length ? [{ ...base, reason: "owner-other-name", held: outside }] : []
  const found: Found[] = []
  const mixed: Held[] = []
  for (const one of outside) {
    if (one.phone !== null && main.some(({ phone }) => phone === one.phone)) continue
    const address = one.email === null ? undefined : main.find(({ email }) => email === one.email)?.email
    if (typeof address === "string") found.push({ ...base, reason: "shared-address", held: [one], address })
    else mixed.push(one)
  }
  if (mixed.length) found.push({ ...base, reason: "mixed-names", held: [...main, ...mixed] })
  return found
}

const byPerson = (held: readonly Held[]): Map<number, Held[]> => {
  const found = new Map<number, Held[]>()
  for (const one of held) {
    const same = found.get(one.person)
    if (same) same.push(one)
    else found.set(one.person, [one])
  }
  return found
}

const ORDER = new Map(DOUBT_REASONS.map((reason, index) => [reason, index]))

/** Everything in doubt, the owner first, then by reason and person. A few thousand people are read, never every row. */
const everyDoubt = (database: CacheDatabase): Found[] => {
  const test = testData(database)
  const testPks = new Set(test.map(({ pk }) => pk))
  const kept = keptTogether(database)
  const found: Found[] = []
  for (const [person, held] of byPerson(sharedPeople(database)))
    for (const one of doubtsOf(held, kept.get(person) ?? new Set(), testPks)) found.push(one)
  for (const held of byPerson(test).values()) {
    const [first] = held as [Held]
    found.push({ person: first.person, owner: first.owner, name: first.personName, reason: "test-data", held })
  }
  return found.sort(
    (a, b) =>
      Number(b.owner) - Number(a.owner) ||
      (ORDER.get(a.reason) ?? 0) - (ORDER.get(b.reason) ?? 0) ||
      a.person - b.person,
  )
}

/**
 * The owner's moves that take the doubted identities off: undoing a merge that brought only doubted ones, and one
 * unlink per name group of the rest, so two strangers on one person do not land on one new person together.
 */
const movesOf = (context: StoreContext, found: Found): DoubtMove[] => {
  if (found.reason === "test-data" || found.reason === "mixed-names") return []
  const doubted = new Set(found.held.map(({ ref }) => ref))
  const moves: DoubtMove[] = []
  const unmerged = new Set<string>()
  for (const merge of merges(context, String(found.person))) {
    const refs = merge.identities.map(({ provider, id }) => `${provider}:${id}`)
    if (refs.length === 0 || !refs.every((ref) => doubted.has(ref))) continue
    moves.push({ op: "unmerge", merge: merge.id })
    for (const ref of refs) unmerged.add(ref)
  }
  const rest = found.held.filter(({ ref }) => !unmerged.has(ref))
  for (const group of nameGroups(rest)) moves.push({ op: "unlink", identities: group.map(({ ref }) => ref) })
  return moves
}

const commandOf = (move: DoubtMove): string =>
  move.op === "unmerge" ? `people unmerge ${move.merge}` : `people unlink ${move.identities.map(shellWord).join(" ")}`

/** A ref as one shell word: an id may hold a space or a quote, and the fix is pasted into a terminal. */
const shellWord = (ref: string): string => (/^[\w@.:+/=-]+$/u.test(ref) ? ref : `'${ref.replaceAll("'", "'\\''")}'`)

const shown = (context: StoreContext, found: Found): PersonDoubt => {
  const moves = movesOf(context, found)
  return {
    person: `person:${found.person}`,
    name: found.name,
    owner: found.owner,
    reason: found.reason,
    why: whyOf(found),
    identities: found.held.map(({ ref, name, method, by, at }) => ({
      identity: ref,
      name,
      method,
      by,
      at: new Date(at).toISOString(),
    })),
    evidence: [
      ...found.held.map(({ ref }) => ref),
      ...(found.address === undefined ? [] : [`email:${found.address}`]),
      ...moves.flatMap((move) => (move.op === "unmerge" ? [move.merge] : [])),
    ],
    fix: moves.map(commandOf),
    moves,
  }
}

/** People that may be wrong, a page at a time, each with why and the owner's moves that would set it right. */
export const personDoubts = (
  context: StoreContext,
  { limit, offset }: { limit: number; offset: number },
): PersonDoubts => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new CliError("validation_error", "a list of doubts takes 1–500 items")
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new CliError("validation_error", "a list of doubts takes a nonnegative offset")
  const found = everyDoubt(context.database)
  return {
    items: found.slice(offset, offset + limit).map((one) => shown(context, one)),
    total: found.length,
    hasMore: found.length > offset + limit,
  }
}
