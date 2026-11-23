import { CliError } from "@wirecat/cli-base"
import type { Decider } from "../decisions.js"
import type { CacheDatabase } from "../driver.js"
import { OWN, referencesTo } from "./accounts.js"
import { count, ErasePlan } from "./erase-plan.js"
import { forgetDanglingEvidence } from "./evidence-signature.js"
import { forgetErasedLinks } from "./identity-link-rows.js"
import { forgetErasedSplits } from "./identity-split-proposals.js"
import { currentPerson } from "./merged-persons.js"
import type { StoreContext } from "./open.js"
import { ownerOnly } from "./person-merges.js"
import { forgetErasedTestData } from "./test-people.js"

export interface PersonErasure {
  person: string
  name: string | null
  /** `false`: what `erase` would do, nothing changed. */
  erased: boolean
  /** Identities that go with the person. */
  identities: string[]
  /**
   * Identities a message, mail, meeting or chat still names: they stay, with no person, and the next sync or people
   * scan gives them one again.
   */
  kept: { identity: string; references: number }[]
  /** Rows that only tied something to the person, such as a tag, a link or a mention, by `table.column`. */
  deleted: Record<string, number>
  /** Rows that stay and lose the person, such as a fact about them or a record made into them. */
  detached: Record<string, number>
}

const personOf = (context: StoreContext, uid: string): number => {
  const asked = /^(?:person:)?([1-9]\d*)$/u.exec(uid.trim())?.[1]
  const known =
    asked === undefined ? undefined : context.database.prepare("SELECT id FROM persons WHERE id = ?").get(Number(asked))
  if (known === undefined)
    throw new CliError("not_found", `the store has no person for "${uid}"`, { reason: "person.unknown" })
  return currentPerson(context.database, Number(known.id))
}

/**
 * Deletes a person and what memo knows of them alone: their identities, the tags, links, aliases and mentions that
 * name them, their involvements. A fact, a note, a record or a task that names them stays and loses the name. A
 * message, mail or meeting is the source's: its sender stays as an identity with no person. Refused for the owner,
 * and while an invoice, order, subscription or a row they wrote cannot be without them. `apply: false` answers the
 * same without changing anything.
 */
export const erasePerson = (context: StoreContext, uid: string, by: Decider, apply: boolean): PersonErasure => {
  ownerOnly(by, "deletes a person")
  const { database } = context
  const person = personOf(context, uid)
  const row = database.prepare("SELECT owner, name FROM persons WHERE id = ?").get(person)
  if (Number(row?.owner) === 1)
    throw new CliError("validation_error", "your own person cannot be deleted", { reason: "person.owner" })
  const linked = database
    .prepare(
      `SELECT i.id AS id, i.provider || ':' || i.external_id AS ref FROM identity_links l
        JOIN identities i ON i.id = l.identity_id WHERE l.person_id = ? ORDER BY i.id`,
    )
    .all(person)
    .map((one) => ({ id: Number(one.id), ref: String(one.ref) }))
  const ids = JSON.stringify(linked.map(({ id }) => id))
  const theirs = "SELECT value FROM json_each(?)"
  const outside = referencesTo(
    database,
    "identities",
    new Set([...OWN, "account_identities", "organization_identities", "involvements"]),
    theirs,
  )
  const named = new Map<number, number>()
  for (const one of database
    .prepare(`SELECT id, count(*) AS n FROM (${outside}) GROUP BY id`)
    .all(...refsOf(outside, ids)))
    named.set(Number(one.id), Number(one.n))
  const going = linked.filter(({ id }) => !named.has(id))
  const kept = linked.filter(({ id }) => named.has(id))
  const goingIds = JSON.stringify(going.map(({ id }) => id))

  const plan = new ErasePlan(database).pointers("person", "?", [person]).pointers("identity", theirs, [goingIds])
  const { deleted, detached, blocked } = plan
  const involvements = count(
    database,
    `involvements WHERE person_id = ? OR identity_id IN (${theirs})`,
    person,
    goingIds,
  )
  if (involvements > 0) deleted["involvements.person"] = (deleted["involvements.person"] ?? 0) + involvements
  const bots = count(database, "bots WHERE owner_person_id = ?", person)
  if (bots > 0) detached["bots.owner_person"] = bots

  if (blocked.length > 0)
    throw new CliError(
      "validation_error",
      `person:${person} is still named by ${blocked.join(", ")}; change those first — nothing was deleted`,
      { reason: "person.erase-blocked", blocked },
    )
  const answer = (erased: boolean): PersonErasure => ({
    person: `person:${person}`,
    name: row?.name == null ? null : String(row.name),
    erased,
    identities: going.map(({ ref }) => ref),
    kept: kept.map(({ id, ref }) => ({ identity: ref, references: named.get(id) ?? 0 })),
    deleted,
    detached,
  })
  if (!apply) return answer(false)

  plan.run()
  database.prepare(`DELETE FROM involvements WHERE person_id = ? OR identity_id IN (${theirs})`).run(person, goingIds)
  database.prepare("UPDATE bots SET owner_person_id = NULL WHERE owner_person_id = ?").run(person)
  for (const table of ["account_identities", "organization_identities", "identity_revisions"])
    database.prepare(`DELETE FROM ${table} WHERE identity_id IN (${theirs})`).run(goingIds)
  database
    .prepare(`DELETE FROM identity_link_events WHERE to_person_id = ? OR identity_id IN (${theirs})`)
    .run(person, goingIds)
  database.prepare("UPDATE identity_link_events SET from_person_id = NULL WHERE from_person_id = ?").run(person)
  database.prepare("DELETE FROM identity_links WHERE person_id = ?").run(person)
  database.prepare(`DELETE FROM identities WHERE id IN (${theirs})`).run(goingIds)
  database.prepare("DELETE FROM persons WHERE id = ?").run(person)
  forgetErasedLinks(database)
  forgetErasedSplits(database)
  forgetErasedTestData(database)
  forgetDanglingEvidence(database, context.now())
  return answer(true)
}

/** `referencesTo` with `among` binds the ids once per arm. */
const refsOf = (sql: string, ids: string) => Array.from({ length: sql.split("json_each(?)").length - 1 }, () => ids)

/** The people an account's records made into persons: read before a purge deletes the records. */
export const importedPeople = (database: CacheDatabase, accountKey: number): number[] =>
  database
    .prepare("SELECT DISTINCT entity_id AS id FROM records WHERE account_id = ? AND entity_type = 'person'")
    .all(accountKey)
    .map(({ id }) => Number(id))

/**
 * After a purge, the people only its records made go too: nothing else names them, and no message, mail or meeting
 * names their identities; their involvements are derived and go with them. One the owner tagged, linked or gave a
 * task to stays.
 */
export const eraseImportedPeople = (context: StoreContext, people: readonly number[]): void => {
  const { database } = context
  const others = referencesTo(
    database,
    "persons",
    new Set(["identity_links", "identity_link_events", "involvements"]),
    "?",
  )
  for (const person of people) {
    if (database.prepare("SELECT 1 FROM persons WHERE id = ? AND owner = 0").get(person) === undefined) continue
    const params = Array.from({ length: others.split("IN (?)").length - 1 }, () => person)
    if (database.prepare(`SELECT 1 FROM (${others}) LIMIT 1`).get(...params) !== undefined) continue
    const plan = erasePerson(context, String(person), "owner", false)
    if (plan.kept.length === 0) erasePerson(context, String(person), "owner", true)
  }
}
