import type { CacheDatabase } from "../driver.js"

/** Moves that take identities apart, never a merge. */
export const SEPARATIONS = ["unlink", "split", "undo-merge"] as const

/**
 * Whether a logged move joined two people, judged by what it did: a merge empties its person, so every other
 * identity on it then moves the same way next. An unlink leaves the rest behind, which is how an unlink stored before
 * it had its own method, or one identity linked out of a person, is told apart. The owner's person has no move of its
 * own, so the person a move goes to says nothing.
 */
export const mergeSql = (event: string): string =>
  `(${event}.from_person_id IS NOT NULL AND ${event}.from_person_id <> ${event}.to_person_id ` +
  `AND ${event}.method NOT IN (${SEPARATIONS.map((method) => `'${method}'`).join(", ")}) ` +
  `AND NOT EXISTS (SELECT 1 FROM identity_link_events stay WHERE stay.to_person_id = ${event}.from_person_id ` +
  `AND stay.identity_id <> ${event}.identity_id AND stay.id < ${event}.id ` +
  `AND stay.id = (SELECT max(s.id) FROM identity_link_events s WHERE s.identity_id = stay.identity_id ` +
  `AND s.id < ${event}.id) ` +
  `AND NOT EXISTS (SELECT 1 FROM identity_link_events went WHERE went.identity_id = stay.identity_id ` +
  `AND went.from_person_id = ${event}.from_person_id AND went.to_person_id = ${event}.to_person_id ` +
  `AND went.id = (SELECT min(w.id) FROM identity_link_events w WHERE w.identity_id = stay.identity_id ` +
  `AND w.id > ${event}.id))))`

/**
 * A person every identity left by a merge, so another person holds them now. The row stays so that undoing the merge
 * gives the uid back; a person added by name has no identity and no move, and stays visible.
 */
export const mergedAwaySql = (person: string): string =>
  `(${person}.owner = 0 AND NOT EXISTS (SELECT 1 FROM identity_links ml WHERE ml.person_id = ${person}.id) ` +
  `AND EXISTS (SELECT 1 FROM identity_link_events me WHERE me.from_person_id = ${person}.id AND ${mergeSql("me")}))`

const LATEST_MOVE = (person: string) =>
  `(SELECT e.to_person_id FROM identity_link_events e WHERE e.from_person_id = ${person}.id AND ${mergeSql("e")}
    ORDER BY e.id DESC LIMIT 1)`

/** The person `pk` is now: itself, or where its identities went, by the latest merge of each merged-away person. */
export const currentPerson = (database: CacheDatabase, pk: number): number => {
  const seen = new Set<number>()
  let at = pk
  while (!seen.has(at)) {
    seen.add(at)
    const next = database
      .prepare(`SELECT ${LATEST_MOVE("p")} AS next FROM persons p WHERE p.id = ? AND ${mergedAwaySql("p")}`)
      .get(at)
    if (next?.next == null) return at
    at = Number(next.next)
  }
  return at
}

/** The person `pk` is now, then every merged-away person whose references now mean it. */
export const samePersons = (database: CacheDatabase, pk: number): number[] => {
  const found = [currentPerson(database, pk)]
  const into = database.prepare(
    `SELECT p.id FROM persons p WHERE p.id IN (SELECT from_person_id FROM identity_link_events WHERE to_person_id = ?)
      AND ${mergedAwaySql("p")} AND ${LATEST_MOVE("p")} = ?`,
  )
  for (let at = 0; at < found.length; at++) {
    const target = found[at] as number
    for (const row of into.all(target, target)) if (!found.includes(Number(row.id))) found.push(Number(row.id))
  }
  return found
}

/**
 * The ids a filter on `type`/`id` covers, as JSON for `IN (SELECT value FROM json_each(?))`: a person with everyone
 * merged into them, since rows naming a merged-away person stay as they were written, so undoing the merge loses none.
 */
export const idsOf = (database: CacheDatabase, type: string, id: number): string =>
  JSON.stringify(type === "person" ? samePersons(database, id) : [id])
