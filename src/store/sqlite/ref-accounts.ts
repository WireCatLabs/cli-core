import { isDocumentAccountProvider, isFolderProvider } from "../../domain/providers.js"
import { parseReference, type Reference } from "../../domain/references.js"
import type { CacheDatabase } from "../driver.js"
import type { AccountKey } from "../types.js"
import { ENTITY_TABLES, isEntityType } from "./entity-types.js"
import { storedThing, type Thing, thingOf } from "./things.js"

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

// Per connection: a long-lived process (`commands --serve`) outlives a migration another CLI runs on the store.
const hasAccountColumn = new WeakMap<CacheDatabase, Map<string, boolean>>()
const accountColumnIn = (database: CacheDatabase, table: string): boolean => {
  const tables = hasAccountColumn.get(database) ?? new Map<string, boolean>()
  hasAccountColumn.set(database, tables)
  const known = tables.get(table)
  if (known !== undefined) return known
  const has = database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((column) => column.name === "account_id")
  tables.set(table, has)
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

const thingAccountIds = (database: CacheDatabase, thing: Thing): number[] => {
  switch (thing.type) {
    // A note written in memo, never a file of a folder (`document:`), is the owner's: no account brought it.
    case "note":
      return []
    case "account":
      return [thing.id]
    case "message":
      return ids(
        database
          .prepare("SELECT c.account_id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ?")
          .all(thing.id),
      )
    // An event is its copies' calendars' and its meetings' accounts; one with no copy is the owner's own.
    case "event":
      return [
        ...ids(
          database
            .prepare(
              "SELECT c.account_id FROM calendar_entries e JOIN calendars c ON c.id = e.calendar_id WHERE e.event_id = ?",
            )
            .all(thing.id),
        ),
        ...ids(database.prepare("SELECT account_id FROM meetings WHERE event_id = ?").all(thing.id)),
      ]
    case "identity":
      return ids(database.prepare("SELECT account_id FROM account_identities WHERE identity_id = ?").all(thing.id))
  }
  if (!isEntityType(thing.type)) return []
  const table = ENTITY_TABLES[thing.type]
  const own = accountColumnIn(database, table)
    ? ids(database.prepare(`SELECT account_id FROM ${table} WHERE id = ?`).all(thing.id))
    : []
  return [
    ...own,
    ...recordAccounts(database, thing.type, thing.id),
    ...(thing.type === "person" ? personAccounts(database, thing.id) : []),
  ]
}

const endOf = (database: CacheDatabase, type: unknown, id: unknown): AccountKey[][] =>
  type === null || type === undefined || id === null || id === undefined
    ? []
    : [accountKeys(database, thingAccountIds(database, storedThing(type, id)))]

/** A proposed action (`action:<id>`) and a suggested link (`link:<id>`): ids of the proposal registry, not references. */
const PROPOSAL = /^(action|link):([1-9]\d*)$/

/**
 * Each part a referenced thing belongs to, every one of which a group must hold: one part for most things; a proposed
 * action's own account and its target; a link's two ends. `undefined` when the store holds nothing for it.
 */
export const refEndsOf = (database: CacheDatabase, text: string): AccountKey[][] | undefined => {
  const proposal = PROPOSAL.exec(text.trim())
  if (proposal) {
    const [, kind, id] = proposal
    if (kind === "action") {
      const row = database
        .prepare("SELECT account_id, target_type, target_id FROM proposed_actions WHERE id = ?")
        .get(Number(id))
      if (!row) return undefined
      return [
        ...(row.account_id === null ? [] : [accountKeys(database, [Number(row.account_id)])]),
        ...endOf(database, row.target_type, row.target_id),
      ]
    }
    const link = database.prepare("SELECT from_type, from_id, to_type, to_id FROM links WHERE id = ?").get(Number(id))
    if (!link) return undefined
    return [...endOf(database, link.from_type, link.from_id), ...endOf(database, link.to_type, link.to_id)]
  }
  let reference: Reference
  try {
    reference = parseReference(text)
  } catch {
    return undefined
  }
  if (reference.type === "message" || reference.type === "chat")
    return [[{ provider: reference.provider, account: reference.account }]]
  const thing = thingOf(database, reference)
  if (!thing) return undefined
  if (reference.type === "meeting") return [accountKeys(database, [reference.accountId])]
  return [accountKeys(database, thingAccountIds(database, thing))]
}

export const refAccountsOf = (database: CacheDatabase, text: string): RefAccounts => refEndsOf(database, text)?.flat()
