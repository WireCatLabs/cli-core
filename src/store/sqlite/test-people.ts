import { RESERVED_ADDRESS_GLOBS, SEED_ID_GLOBS, SEED_PEOPLE } from "../../domain/test-data.js"
import type { CacheDatabase } from "../driver.js"
import { personOf, pkOf } from "./identity-link-rows.js"
import type { StoreContext } from "./open.js"
import { proposalOperationsOver } from "./proposed-actions.js"

/** The owner's word on identities: approved, they are test data; rejected, a real contact. */
export const TEST_DATA_KIND = "test_data"

interface TestDataPayload {
  person: string
  identities: string[]
}

const globs = (column: string, patterns: readonly string[]) =>
  patterns.map((pattern) => `${column} GLOB '${pattern}'`).join(" OR ")

/** A seed id or an address at a reserved domain: nothing real has one, so memo hides it without asking. */
const SURE = `(${globs("i.external_id", SEED_ID_GLOBS)} OR ${globs("lower(i.email)", RESERVED_ADDRESS_GLOBS)})`

/** A seed name with its username or beside another seed name in one provider: one name alone may be a real person's. */
const SEED_NAMED =
  "(i.name IN (SELECT value FROM json_each(?)) AND (i.username IN (SELECT value FROM json_each(?)) " +
  "OR (SELECT count(DISTINCT j.name) FROM identities j WHERE j.provider = i.provider " +
  "AND j.name IN (SELECT value FROM json_each(?))) >= 2))"

const seedParams = (): string[] => {
  const names = JSON.stringify(SEED_PEOPLE.map(({ name }) => name))
  const usernames = JSON.stringify(SEED_PEOPLE.flatMap(({ username }) => (username === null ? [] : [username])))
  return [names, usernames, names]
}

/** The SQL that picks a test run's identities, aliased `i`, and its parameters; `sure` is a column of it. */
export const testIdentitySql = (): { where: string; sure: string; params: string[] } => ({
  where: `(${SURE} OR ${SEED_NAMED})`,
  sure: `${SURE} AS sure`,
  params: seedParams(),
})

/** The owner's newest word on each identity: `true` test data, `false` a real contact. */
export const testVerdicts = (database: CacheDatabase): Map<string, boolean> => {
  const verdicts = new Map<string, boolean>()
  for (const row of database
    .prepare(
      "SELECT status, payload FROM proposed_actions WHERE kind = ? AND status IN ('approved', 'rejected') ORDER BY id",
    )
    .all(TEST_DATA_KIND))
    for (const ref of (JSON.parse(String(row.payload)) as TestDataPayload).identities)
      verdicts.set(ref, row.status === "approved")
  return verdicts
}

/**
 * People memo keeps out of every list as test data: each identity is a sure test run's or one the owner called test
 * data, and the owner called none a real contact. Never the owner.
 */
export const hiddenTestPeople = (database: CacheDatabase): Set<number> => {
  const { where, sure, params } = testIdentitySql()
  const verdicts = testVerdicts(database)
  const test = new Map<number, Map<string, boolean>>()
  const note = (person: number, ref: string, isSure: boolean) => {
    const refs = test.get(person) ?? new Map<string, boolean>()
    refs.set(ref, isSure || refs.get(ref) === true)
    test.set(person, refs)
  }
  for (const row of database
    .prepare(
      `SELECT l.person_id AS person, i.provider || ':' || i.external_id AS ref, ${sure} FROM identity_links l ` +
        `JOIN identities i ON i.id = l.identity_id WHERE ${where}`,
    )
    .all(...params))
    note(Number(row.person), String(row.ref), Number(row.sure) === 1)
  for (const [ref, isTest] of verdicts) {
    if (!isTest) continue
    const person = personOf(database, pkOf(database, ref))
    if (person !== undefined) note(person, ref, false)
  }
  const hidden = new Set<number>()
  const held = database.prepare(
    "SELECT count(*) AS n, max(p.owner) AS owner FROM identity_links l JOIN persons p ON p.id = l.person_id " +
      "WHERE l.person_id = ?",
  )
  for (const [person, refs] of test) {
    const told = [...refs].every(([ref, isSure]) => verdicts.get(ref) ?? isSure)
    if (!told) continue
    const row = held.get(person)
    if (Number(row?.owner) !== 1 && Number(row?.n) === refs.size) hidden.add(person)
  }
  return hidden
}

/**
 * Records the owner's word on the identities: test data, or a real contact. The next people list works the person's
 * kind out again, since no trigger watches a decision.
 */
export const judgeTestData = (
  context: StoreContext,
  person: number,
  identities: readonly string[],
  test: boolean,
): void => {
  const operations = proposalOperationsOver(context)
  const payload: TestDataPayload = { person: String(person), identities: [...identities] }
  const reason = test ? "the owner called it test data" : "the owner called it a real contact"
  const proposed = operations.propose({ kind: TEST_DATA_KIND, by: "owner", payload, reason })
  if (test) operations.approve(proposed.id, { reason })
  else operations.reject(proposed.id, "owner", { reason })
  context.database.prepare("UPDATE persons SET kind = NULL WHERE id = ?").run(person)
}

/** Deletes the owner's words on identities no longer in the store: a payload names the address. */
export const forgetErasedTestData = (database: CacheDatabase): void => {
  for (const row of database.prepare("SELECT id, payload FROM proposed_actions WHERE kind = ?").all(TEST_DATA_KIND))
    if (
      (JSON.parse(String(row.payload)) as TestDataPayload).identities.some((ref) => pkOf(database, ref) === undefined)
    )
      database.prepare("DELETE FROM proposed_actions WHERE id = ?").run(Number(row.id))
}
