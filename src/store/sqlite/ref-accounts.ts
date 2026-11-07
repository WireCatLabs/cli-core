import { isDocumentAccountProvider, isFolderProvider } from "../../domain/providers.js"
import { parseReference, type Reference } from "../../domain/references.js"
import type { CacheDatabase } from "../driver.js"
import type { AccountKey } from "../types.js"
import { ENTITY_TABLES } from "./entity-types.js"
import { thingOf } from "./things.js"

/**
 * The accounts a referenced thing belongs to. `[]` is a thing no account brought, such as one the owner made;
 * `undefined` is a reference the store holds nothing for, which the command itself then reports.
 */
export type RefAccounts = AccountKey[] | undefined

const accountKeys = (database: CacheDatabase, ids: readonly number[]): AccountKey[] => {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  return database
    .prepare(`SELECT id, provider, external_id FROM accounts WHERE id IN (${unique.map(() => "?").join(",")})`)
    .all(...unique)
    .map(({ id, provider, external_id }) =>
      // A notes folder or a documents account is `notes:<its store id>`, as source lists and groups name it.
      isFolderProvider(String(provider)) || isDocumentAccountProvider(String(provider))
        ? { provider: "notes", account: String(id) }
        : { provider: String(provider), account: String(external_id) },
    )
}

const hasAccountColumn = new Map<string, boolean>()
const accountColumnIn = (database: CacheDatabase, table: string): boolean => {
  const known = hasAccountColumn.get(table)
  if (known !== undefined) return known
  const has = database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((column) => column.name === "account_id")
  hasAccountColumn.set(table, has)
  return has
}

const ids = (rows: readonly Record<string, unknown>[]) =>
  rows.flatMap(({ account_id }) => (account_id === null || account_id === undefined ? [] : [Number(account_id)]))

/** Every source record of the row, as a CRM's or another import's copy of it. */
const recordAccounts = (database: CacheDatabase, type: string, id: number) =>
  ids(database.prepare("SELECT account_id FROM records WHERE entity_type = ? AND entity_id = ?").all(type, id))

/** The accounts that hold one of the person's identities. */
const personAccounts = (database: CacheDatabase, id: number) =>
  ids(
    database
      .prepare(
        "SELECT ai.account_id FROM identity_links l JOIN account_identities ai ON ai.identity_id = l.identity_id " +
          "WHERE l.person_id = ?",
      )
      .all(id),
  )

export const refAccountsOf = (database: CacheDatabase, text: string): RefAccounts => {
  let reference: Reference
  try {
    reference = parseReference(text)
  } catch {
    return undefined
  }
  if (reference.type === "message" || reference.type === "chat")
    return [{ provider: reference.provider, account: reference.account }]
  const thing = thingOf(database, reference)
  if (!thing) return undefined
  if (reference.type === "meeting") return accountKeys(database, [reference.accountId])
  switch (thing.type) {
    // A note written in memo, never a file of a folder (`document:`), is the owner's: no account brought it.
    case "note":
      return []
    case "account":
      return accountKeys(database, [thing.id])
    // An event is its copies' calendars' and its meetings' accounts; one with no copy is the owner's own.
    case "event":
      return accountKeys(database, [
        ...ids(
          database
            .prepare(
              "SELECT c.account_id FROM calendar_entries e JOIN calendars c ON c.id = e.calendar_id WHERE e.event_id = ?",
            )
            .all(thing.id),
        ),
        ...ids(database.prepare("SELECT account_id FROM meetings WHERE event_id = ?").all(thing.id)),
      ])
    case "identity":
      return accountKeys(
        database,
        ids(database.prepare("SELECT account_id FROM account_identities WHERE identity_id = ?").all(thing.id)),
      )
  }
  const table = ENTITY_TABLES[thing.type]
  const own = accountColumnIn(database, table)
    ? ids(database.prepare(`SELECT account_id FROM ${table} WHERE id = ?`).all(thing.id))
    : []
  return accountKeys(database, [
    ...own,
    ...recordAccounts(database, thing.type, thing.id),
    ...(thing.type === "person" ? personAccounts(database, thing.id) : []),
  ])
}
