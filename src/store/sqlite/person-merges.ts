import { CliError } from "@wirecat/cli-base"
import type { IdentityRef, PersonRecord } from "../types.js"
import { currentPerson, mergeSql, SEPARATIONS } from "./merged-persons.js"
import type { StoreContext } from "./open.js"
import { move, recordOf, renameAfterLeaving, required } from "./person-links.js"
import { persons } from "./schema.js"

export interface PersonMerge {
  /** `merge:<to>-<from>`, what `undoMerge` takes back. */
  id: string
  from: string
  to: string
  identities: (IdentityRef & { name: string | null })[]
  method: string
  by: string
  at: string
}

export const mergeId = (to: number | string, from: number | string): string => `merge:${to}-${from}`

/** The two uids a `merge:<to>-<from>` id names. */
export const parseMergeId = (id: string): { to: string; from: string } => {
  const found = /^merge:([1-9]\d*)-([1-9]\d*)$/.exec(id.trim())
  if (!found) throw new CliError("validation_error", `${id} is not a merge id; it looks like merge:12-34`)
  return { to: found[1] as string, from: found[2] as string }
}

const personPk = ({ database }: StoreContext, uid: string): number => {
  const found = /^[1-9]\d*$/.test(uid) ? database.prepare("SELECT id FROM persons WHERE id = ?").get(uid) : undefined
  if (!found) throw new CliError("not_found", `no person:${uid} in the store`)
  return Number(found.id)
}

const ownerOnly = (by: string, what: string) => {
  if (by !== "owner")
    throw new CliError("permission_error", `only the owner ${what}`, { reason: "identity.owner-only" })
}

interface Arrival {
  pk: number
  from: number
  method: string
  by: string
  at: number
}

/**
 * The merge that brought each identity now on `to` there. An undo that brought one back to `to` restores the merge
 * it had before it left, so a chain of merges undoes newest first; any other arrival means it came by no merge.
 */
const arrivals = ({ database }: StoreContext, to: number): Map<number, Arrival> => {
  const rows = database
    .prepare(
      `SELECT e.identity_id AS pk, e.from_person_id AS person, e.method, e.author, e.created_at, ${mergeSql("e")} AS merge
        FROM identity_link_events e JOIN identity_links l ON l.identity_id = e.identity_id AND l.person_id = e.to_person_id
        WHERE e.to_person_id = ? ORDER BY e.id`,
    )
    .all(to)
  const found = new Map<number, Arrival | undefined>()
  for (const row of rows) {
    const pk = Number(row.pk)
    if (Number(row.merge))
      found.set(pk, {
        pk,
        from: Number(row.person),
        method: String(row.method),
        by: String(row.author),
        at: Number(row.created_at),
      })
    else if (row.method !== "undo-merge") found.set(pk, undefined)
  }
  return new Map([...found].filter((entry): entry is [number, Arrival] => entry[1] !== undefined))
}

/**
 * The people merged into this person, each with the identities from it that are still here. Grouped by person, not
 * by time: a merge stamps each identity on its own.
 */
export const merges = (context: StoreContext, uid: string): PersonMerge[] => {
  const to = currentPerson(context.database, personPk(context, uid))
  const named = context.database.prepare("SELECT provider, external_id, name FROM identities WHERE id = ?")
  const found = new Map<number, PersonMerge>()
  for (const arrival of [...arrivals(context, to).values()].sort((a, b) => a.at - b.at || a.pk - b.pk)) {
    const row = named.get(arrival.pk)
    const identities = found.get(arrival.from)?.identities ?? []
    identities.push({
      provider: String(row?.provider),
      id: String(row?.external_id),
      name: row?.name == null ? null : String(row.name),
    })
    found.set(arrival.from, {
      id: mergeId(to, arrival.from),
      from: String(arrival.from),
      to: String(to),
      identities,
      method: arrival.method,
      by: arrival.by,
      at: new Date(arrival.at).toISOString(),
    })
  }
  return [...found.values()].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
}

/**
 * Moves the identities that came from `from` and are still on `to` back to `from`, as the owner's move, so no
 * automatic link joins them again. One the owner split or unlinked off since stays where the owner put it. Refused
 * with `identity.stale` when one left `to` by a merge: undoing would take it from wherever it is now.
 *
 * `by` is `"owner"` only on a path that established the owner ran it: an agent's call must never pass it.
 */
export const undoMerge = (context: StoreContext, toUid: string, fromUid: string, by: string): PersonRecord => {
  ownerOnly(by, "undoes a merge")
  const to = personPk(context, toUid)
  const from = personPk(context, fromUid)
  const here = [...arrivals(context, to).values()].filter((arrival) => arrival.from === from)
  const left = context.database
    .prepare(
      `SELECT (SELECT n.method FROM identity_link_events n WHERE n.identity_id = m.identity_id AND n.id > m.id
          AND n.from_person_id = m.to_person_id ORDER BY n.id LIMIT 1) AS method
        FROM identity_link_events m JOIN identity_links l ON l.identity_id = m.identity_id AND l.person_id NOT IN (?, ?)
        WHERE m.from_person_id = ? AND m.to_person_id = ? AND ${mergeSql("m")}
          AND m.id = (SELECT max(y.id) FROM identity_link_events y WHERE y.identity_id = m.identity_id
            AND y.from_person_id = m.from_person_id AND y.to_person_id = m.to_person_id)`,
    )
    .all(to, from, from, to)
  if (left.some(({ method }) => !(SEPARATIONS as readonly unknown[]).includes(method)))
    throw new CliError("conflict", `an identity of ${mergeId(toUid, fromUid)} was merged on since; undo that first`, {
      reason: "identity.stale",
    })
  if (here.length === 0) throw new CliError("not_found", `nothing of person:${fromUid} is merged into person:${toUid}`)
  for (const { pk } of here) move(context, pk, to, from, { method: "undo-merge", by })
  renameAfterLeaving(
    context,
    to,
    here.map(({ pk }) => pk),
  )
  return recordOf(context, from)
}

/**
 * Moves the chosen identities to one new person, as the owner's move; the person keeps the rest.
 *
 * `by` is `"owner"` only on a path that established the owner ran it: an agent's call must never pass it.
 */
export const split = (context: StoreContext, uid: string, refs: IdentityRef[], by: string): PersonRecord => {
  ownerOnly(by, "splits a person")
  const person = currentPerson(context.database, personPk(context, uid))
  const chosen = [...new Map(refs.map((ref) => [`${ref.provider}:${ref.id}`, ref])).values()]
  if (chosen.length === 0) throw new CliError("validation_error", "name at least one identity to split off")
  const found = chosen.map((ref) => {
    const row = required(context, ref)
    if (row.personPk !== person)
      throw new CliError("validation_error", `${ref.provider}:${ref.id} is not an identity of person:${person}`)
    return row
  })
  if (found.length === recordOf(context, person).identities.length)
    throw new CliError("validation_error", "a split leaves at least one identity with the person")
  const at = context.now()
  const name = context.database.prepare("SELECT name FROM identities WHERE id = ?").get((found[0] as { pk: number }).pk)
  const alone = Number(
    context.orm
      .insert(persons)
      .values({ name: name?.name == null ? null : String(name.name), createdAt: at, updatedAt: at })
      .returning({ pk: persons.id })
      .get()?.pk,
  )
  for (const { pk } of found) move(context, pk, person, alone, { method: "split", by })
  renameAfterLeaving(
    context,
    person,
    found.map(({ pk }) => pk),
  )
  return recordOf(context, alone)
}
