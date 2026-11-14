import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"
import type { AccountKey, StoredAccount } from "../types.js"
import { and, asc, eq, sql } from "./drizzle/core.js"
import { pointerPairs } from "./entity-types.js"
import { forgetErasedLinks } from "./identity-link-rows.js"
import { forgetErasedSplits } from "./identity-split-proposals.js"
import { mergeSql } from "./merged-persons.js"
import type { StoreContext } from "./open.js"
import { accounts } from "./schema.js"
import { forgetErasedTestData } from "./test-people.js"

/**
 * An account's row, made on first sight; a name only replaces what was known when there is one. `startScope` is the
 * scope a new row takes; an existing row keeps its own, so a CLI's default never undoes the owner's choice.
 */
export const accountPk = (
  { orm, now }: StoreContext,
  { provider, account, scope }: AccountKey,
  name: string | null = null,
  startScope?: StoredAccount["scope"],
) =>
  Number(
    orm
      .insert(accounts)
      .values({
        provider,
        externalId: account,
        name,
        scope: scope ?? startScope ?? "personal",
        createdAt: now(),
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: [accounts.provider, accounts.externalId],
        set: {
          scope: scope ?? sql`${accounts.scope}`,
          name: sql`coalesce(excluded.name, ${accounts.name})`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({ pk: accounts.id })
      .get()?.pk,
  )

export const findAccountPk = ({ orm }: StoreContext, { provider, account }: AccountKey): number | undefined =>
  orm
    .select({ pk: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.provider, provider), eq(accounts.externalId, account)))
    .get()?.pk

export const accountName = ({ orm }: StoreContext, { provider, account }: AccountKey): string | null =>
  orm
    .select({ name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.provider, provider), eq(accounts.externalId, account)))
    .get()?.name ?? null

export const heldAccounts = ({ orm }: StoreContext): AccountKey[] =>
  orm
    .select({ provider: accounts.provider, account: accounts.externalId })
    .from(accounts)
    .orderBy(asc(accounts.provider), asc(accounts.externalId))
    .all()

/** Every account with the store's id for it, by provider then external id. */
const STORED = {
  id: accounts.id,
  provider: accounts.provider,
  account: accounts.externalId,
  name: accounts.name,
  scope: accounts.scope,
}

export const storedAccounts = ({ orm }: StoreContext): StoredAccount[] =>
  orm.select(STORED).from(accounts).orderBy(asc(accounts.provider), asc(accounts.externalId)).all() as StoredAccount[]

/** One account by provider and external id, never created; a missing one is `not_found`. */
export const storedAccount = ({ orm }: StoreContext, { provider, account }: AccountKey): StoredAccount => {
  const found = orm
    .select(STORED)
    .from(accounts)
    .where(and(eq(accounts.provider, provider), eq(accounts.externalId, account)))
    .get()
  if (!found) throw new CliError("not_found", `no ${provider} account ${account} in the store`)
  return found as StoredAccount
}

/**
 * The owner's word on which side of his life an account is. Triggers move its conversation pieces and involvements;
 * the other search pieces copied the account's scope when they were cut, so they move here, and the word indexes of
 * its documents, mail and calendar events are queued to be built again. A chat with its own scope keeps it; memories
 * and facts carry the scope they were written with.
 */
export const setAccountScope = (
  context: StoreContext,
  key: AccountKey,
  scope: StoredAccount["scope"],
): StoredAccount => {
  const { database, now } = context
  const held = storedAccount(context, key)
  if (held.scope === scope) return held
  database.prepare("UPDATE accounts SET scope = ?, updated_at = ? WHERE id = ?").run(scope, now(), held.id)
  database
    .prepare(
      "UPDATE chunks SET scope = ? WHERE account_id = ? AND chunkable_type <> 'conversation' AND scope IN ('personal', 'work')",
    )
    .run(scope, held.id)
  for (const [type, ids] of [
    ["document", "SELECT id FROM documents WHERE account_id = ?"],
    ["email", "SELECT id FROM emails WHERE account_id = ?"],
    [
      "event",
      "SELECT DISTINCT ce.event_id AS id FROM calendar_entries ce JOIN calendars c ON c.id = ce.calendar_id " +
        "WHERE c.account_id = ? AND ce.event_id IS NOT NULL",
    ],
  ] as const)
    database
      .prepare(`INSERT OR IGNORE INTO ${type}_index_pending (indexable_type, id) SELECT '${type}', id FROM (${ids})`)
      .run(held.id)
  return { ...held, scope }
}

/** Identity and person rows a person's own record keeps, not evidence that anyone saw them. */
export const OWN = new Set(["identity_links", "identity_link_events", "identity_revisions"])

/**
 * Every row that points at `table`: foreign keys and `<name>_type` pointers, read from the store so a new one counts.
 * `among`, a subquery of ids, limits each arm to them, so each reads its index rather than its whole table.
 */
export const referencesTo = (
  database: CacheDatabase,
  table: "identities" | "persons",
  skip: Set<string>,
  among?: string,
): string => {
  const within = (column: string) => (among === undefined ? "" : ` ${column} IN (${among})`)
  const keys = database
    .prepare(
      `SELECT m.name AS tbl, f."from" AS col FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table' AND f."table" = ?`,
    )
    .all(table)
    .filter((row) => !skip.has(String(row.tbl)))
    .map((row) => {
      const column = `"${String(row.col)}"`
      return `SELECT ${column} AS id FROM "${String(row.tbl)}"${among === undefined ? "" : ` WHERE${within(column)}`}`
    })
  const type = table === "identities" ? "identity" : "person"
  const pointers = pointerPairs(database).map(
    ({ table: tbl, pointer }) =>
      `SELECT ${pointer}_id AS id FROM "${tbl}" WHERE ${pointer}_type = '${type}'` +
      (among === undefined ? "" : ` AND${within(`${pointer}_id`)}`),
  )
  return [...keys, ...pointers].join(" UNION ")
}

export const unreferenced = (database: CacheDatabase, table: "identities"): Set<number> =>
  new Set(
    database
      .prepare(
        `SELECT id FROM ${table} WHERE id NOT IN (SELECT id FROM (${referencesTo(database, table, OWN)}) WHERE id IS NOT NULL)`,
      )
      .all()
      .map(({ id }) => Number(id)),
  )

/**
 * People only the purged account had seen go with it. An identity stays while anything else points at it
 * (another account, a tag, a note, a link), or while its person is kept: the owner, a person something
 * points at, or one linked to an identity that stays. An identity also stays while a person it was merged out of is
 * pointed at, so that person stays merged away and its references keep meaning the person it is now. A person the
 * identity was merged out of goes too, unless another identity's move or anything else still points at it.
 */
export const dropOrphanPeople = (database: CacheDatabase, unseenBefore: Set<number>) => {
  const orphans = [...unreferenced(database, "identities")].filter((id) => !unseenBefore.has(id))
  if (orphans.length === 0) return
  const ids = JSON.stringify(orphans)
  const personRefs = referencesTo(database, "persons", OWN)
  const kept = new Set(
    database
      .prepare(
        `SELECT DISTINCT l.identity_id AS id FROM identity_links l JOIN persons p ON p.id = l.person_id
          WHERE l.identity_id IN (SELECT value FROM json_each(?)) AND (p.owner <> 0
            OR p.id IN (SELECT id FROM (${personRefs}) WHERE id IS NOT NULL)
            OR EXISTS (SELECT 1 FROM identity_link_events e WHERE e.identity_id = l.identity_id AND ${mergeSql("e")}
              AND e.from_person_id IN (SELECT id FROM (${personRefs}) WHERE id IS NOT NULL))
            OR EXISTS (SELECT 1 FROM identity_links o WHERE o.person_id = p.id
              AND o.identity_id NOT IN (SELECT value FROM json_each(?))))`,
      )
      .all(ids, ids)
      .map(({ id }) => Number(id)),
  )
  const gone = JSON.stringify(orphans.filter((id) => !kept.has(id)))
  const persons = database
    .prepare(
      `SELECT person_id AS id FROM identity_links WHERE identity_id IN (SELECT value FROM json_each(?))
        UNION SELECT from_person_id FROM identity_link_events WHERE identity_id IN (SELECT value FROM json_each(?))
          AND from_person_id IS NOT NULL`,
    )
    .all(gone, gone)
    .map(({ id }) => Number(id))
  for (const table of ["identity_revisions", "identity_link_events", "identity_links"])
    database.prepare(`DELETE FROM ${table} WHERE identity_id IN (SELECT value FROM json_each(?))`).run(gone)
  database.prepare("DELETE FROM identities WHERE id IN (SELECT value FROM json_each(?))").run(gone)
  forgetErasedLinks(database)
  forgetErasedSplits(database)
  forgetErasedTestData(database)
  database
    .prepare(
      `DELETE FROM persons WHERE id IN (SELECT value FROM json_each(?)) AND owner = 0
        AND NOT EXISTS (SELECT 1 FROM identity_links l WHERE l.person_id = persons.id)
        AND CAST(id AS TEXT) NOT IN (SELECT json_extract(payload, '$.person') FROM proposed_actions
          WHERE kind = 'identity_split')
        AND id NOT IN (SELECT id FROM (${referencesTo(database, "persons", new Set(["identity_links"]))}) WHERE id IS NOT NULL)`,
    )
    .run(JSON.stringify(persons))
}
