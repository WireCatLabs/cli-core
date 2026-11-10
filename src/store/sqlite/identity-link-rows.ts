import type { CacheDatabase } from "../driver.js"
import { IDENTITY_LINK_KIND, type IdentityLinkPayload } from "../identity-links.js"
import { currentPerson } from "./merged-persons.js"

/** A stored `identity_link`, with the two people its identities are on now. */
export interface LinkRow {
  id: string
  status: string
  payload: IdentityLinkPayload
  /** `undefined` once a purge erased an identity it names. */
  pair: [number, number] | undefined
}

export const pairOf = (a: number | string, b: number | string): string =>
  [Number(a), Number(b)].sort((x, y) => x - y).join("-")

/** The identity a `provider:id` names, if the store still has it. */
export const pkOf = (database: CacheDatabase, ref: string): number | undefined => {
  const at = ref.indexOf(":")
  const row = database
    .prepare("SELECT id FROM identities WHERE provider = ? AND external_id = ?")
    .get(ref.slice(0, at), ref.slice(at + 1))
  return row ? Number(row.id) : undefined
}

export const personOf = (database: CacheDatabase, identity: number | undefined): number | undefined => {
  if (identity === undefined) return undefined
  const row = database.prepare("SELECT person_id FROM identity_links WHERE identity_id = ?").get(identity)
  return row ? Number(row.person_id) : undefined
}

/** The people a proposal's identities are on now; merges since may have moved either side. */
export const currentPairOf = (database: CacheDatabase, payload: IdentityLinkPayload): [number, number] | undefined => {
  const from = personOf(database, pkOf(database, payload.identity))
  const to =
    payload.with === null
      ? currentPerson(database, Number(payload.persons[1]))
      : personOf(database, pkOf(database, payload.with))
  return from === undefined || to === undefined ? undefined : [from, to]
}

/** The proposals that still say something: waiting for the owner, or turned down by them; a `page` is newest first. */
export const linkRows = (
  database: CacheDatabase,
  statuses: readonly string[] = ["proposed", "rejected"],
  page?: { limit: number; offset: number },
): LinkRow[] =>
  database
    .prepare(
      "SELECT id, status, payload FROM proposed_actions WHERE kind = ? " +
        `AND status IN (SELECT value FROM json_each(?)) ORDER BY id${page === undefined ? "" : " DESC LIMIT ? OFFSET ?"}`,
    )
    .all(IDENTITY_LINK_KIND, JSON.stringify(statuses), ...(page === undefined ? [] : [page.limit, page.offset]))
    .map((row) => {
      const payload = JSON.parse(String(row.payload)) as IdentityLinkPayload
      return { id: String(row.id), status: String(row.status), payload, pair: currentPairOf(database, payload) }
    })

/**
 * What a proposal rests on: its signal and the two identities it names, in either order. The owner's rejection
 * holds against this evidence only (NEED-2444); a new signal or identity for the same people proposes them again.
 */
export const evidenceKeyOf = ({
  signal,
  identity,
  with: other,
}: Pick<IdentityLinkPayload, "signal" | "identity" | "with">) => `${signal} ${[identity, other ?? ""].sort().join(" ")}`

/** The evidence the owner rejected for linking these two people, by any proposal that names them now. */
export const rejectedEvidence = (database: CacheDatabase, a: number, b: number): Set<string> | undefined => {
  if (
    database
      .prepare("SELECT 1 FROM proposed_actions WHERE kind = ? AND status = 'rejected' LIMIT 1")
      .get(IDENTITY_LINK_KIND) === undefined
  )
    return undefined
  const keys = linkRows(database, ["rejected"])
    .filter(({ pair }) => pair !== undefined && pairOf(...pair) === pairOf(a, b))
    .map(({ payload }) => evidenceKeyOf(payload))
  return keys.length === 0 ? undefined : new Set(keys)
}

/**
 * Every proposal by the pair of people it names now, read once, for a pass that checks many pairs: the open one, and
 * the evidence the owner rejected. `merged` keeps it true after the pass joins two people itself.
 */
export const linkIndex = (database: CacheDatabase) => {
  const rows = linkRows(database)
  const open = new Map<string, LinkRow>()
  const rejected = new Map<string, Set<string>>()
  const byIdentity = new Set<string>()
  const place = (row: LinkRow) => {
    if (row.pair === undefined) return
    const key = pairOf(...row.pair)
    if (row.status !== "rejected") {
      if (!open.has(key)) open.set(key, row)
      return
    }
    const keys = rejected.get(key) ?? new Set<string>()
    keys.add(evidenceKeyOf(row.payload))
    rejected.set(key, keys)
  }
  for (const row of rows) {
    place(row)
    byIdentity.add(row.payload.identity)
  }
  return {
    /** Whether any proposal, open or rejected, names this pair. */
    known: (a: number, b: number): boolean => open.has(pairOf(a, b)) || rejected.has(pairOf(a, b)),
    open: (a: number, b: number): LinkRow | undefined => open.get(pairOf(a, b)),
    rejected: (a: number, b: number): ReadonlySet<string> | undefined => rejected.get(pairOf(a, b)),
    /** Whether any proposal moves this identity, such as a meeting guest's that is already waiting. */
    names: (identity: string): boolean => byIdentity.has(identity),
    add: (row: LinkRow) => {
      rows.push(row)
      place(row)
      byIdentity.add(row.payload.identity)
    },
    merged: (from: number, into: number) => {
      open.clear()
      rejected.clear()
      for (const row of rows) {
        if (row.pair !== undefined)
          row.pair = row.pair.map((person) => (person === from ? into : person)) as [number, number]
        place(row)
      }
    },
  }
}

export type LinkIndex = ReturnType<typeof linkIndex>

/** The identities on a person now, as one comparable string. */
export const sideOf = (database: CacheDatabase, person: number): string =>
  database
    .prepare("SELECT identity_id FROM identity_links WHERE person_id = ? ORDER BY identity_id")
    .all(person)
    .map(({ identity_id }) => String(identity_id))
    .join(",")

export const sidesOf = (database: CacheDatabase, a: number, b: number): [string, string] => [
  sideOf(database, a),
  sideOf(database, b),
]

/**
 * Brings open proposals up to date with the people they name: one whose two people are one now, whose identity a
 * purge erased, or that a merge made a second one for the same pair, is deleted, since nothing is left to decide; a
 * live one takes the people and sides it names now, so the owner decides what is there. With `persons`, only the
 * proposals that name one of them.
 */
export const settleLinks = (database: CacheDatabase, persons?: readonly number[]): void => {
  const named = persons === undefined ? undefined : new Set(persons.map(String))
  const rows = linkRows(database, ["proposed"])
  const first = new Map<string, string>()
  for (const row of rows)
    if (row.pair !== undefined && !first.has(pairOf(...row.pair))) first.set(pairOf(...row.pair), row.id)
  for (const row of rows) {
    if (named !== undefined && !row.payload.persons.some((person) => named.has(person))) continue
    if (row.pair === undefined || row.pair[0] === row.pair[1] || first.get(pairOf(...row.pair)) !== row.id) {
      database.prepare("DELETE FROM proposed_actions WHERE id = ?").run(Number(row.id))
      continue
    }
    const persons: [string, string] = [String(row.pair[0]), String(row.pair[1])]
    const sides = sidesOf(database, ...row.pair)
    if (persons.join() === row.payload.persons.join() && sides.join("|") === row.payload.sides.join("|")) continue
    database
      .prepare("UPDATE proposed_actions SET payload = ? WHERE id = ?")
      .run(JSON.stringify({ ...row.payload, persons, sides }), Number(row.id))
  }
}

/**
 * Deletes every `identity_link` that names an identity no longer in the store, whatever its status: its payload
 * names the identity's phone or address, which must go with it.
 */
export const forgetErasedLinks = (database: CacheDatabase): void => {
  for (const row of linkRows(database, ["proposed", "approved", "rejected", "executed", "failed"]))
    if (
      pkOf(database, row.payload.identity) === undefined ||
      (row.payload.with !== null && pkOf(database, row.payload.with) === undefined)
    )
      database.prepare("DELETE FROM proposed_actions WHERE id = ?").run(Number(row.id))
}
