import { CliError } from "@wirecat/cli-base"
import type { Id, Provider } from "../../domain/models.js"
import type { CacheDatabase } from "../driver.js"
import { pointerPairs } from "./entity-types.js"
import { settleLinks } from "./identity-link-rows.js"
import type { StoreContext } from "./open.js"
import { mergePerson } from "./person-links.js"
import { write } from "./transaction.js"

export type IdentityRenameOutcome = "renamed" | "merged" | "untouched"

export interface IdentityRenames {
  /** How many of the pairs this pass got to, from the first: the rest wait for another call. */
  taken: number
  renamed: number
  merged: number
  untouched: number
  refused: { from: Id; to: Id; error: unknown }[]
}

type Row = Record<string, unknown>

interface UniqueKey {
  columns: string[]
  where: string | null
}

const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`

const columnsOf = (database: CacheDatabase, table: string): Row[] =>
  database.prepare("SELECT name, pk, type FROM pragma_table_info(?)").all(table)

/** Every column a foreign key points from at `table`, identity_links last: deleting its row drops involvements. */
export const foreignKeysTo = (database: CacheDatabase, table: string): { table: string; column: string }[] =>
  database
    .prepare(
      `SELECT m.name AS tbl, f."from" AS col FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table' AND f."table" = ? ORDER BY m.name = 'identity_links', m.name, f."from"`,
    )
    .all(table)
    .map((row) => ({ table: String(row.tbl), column: String(row.col) }))

/** The unique keys of `table` that hold `column`: indexes, and an integer primary key, which has none. */
const uniqueKeys = (database: CacheDatabase, table: string, column: string): UniqueKey[] => {
  const keys: UniqueKey[] = []
  const primary = columnsOf(database, table).filter((one) => Number(one.pk) > 0)
  if (primary.length === 1 && primary[0]?.name === column && String(primary[0]?.type).toLowerCase() === "integer")
    keys.push({ columns: [column], where: null })
  for (const index of database
    .prepare('SELECT name, partial FROM pragma_index_list(?) WHERE "unique" = 1')
    .all(table)) {
    const columns = database
      .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
      .all(String(index.name))
      .map((one) => String(one.name))
    if (!columns.includes(column)) continue
    const sql = Number(index.partial)
      ? String(database.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(String(index.name))?.sql ?? "")
      : ""
    const where = /\bWHERE\b([\s\S]*)$/i.exec(sql)?.[1]?.trim() ?? null
    keys.push({ columns, where })
  }
  return keys
}

const rowKey = (database: CacheDatabase, table: string): string =>
  columnsOf(database, table).some((one) => one.name === "id" && Number(one.pk) === 1) ? "id" : "rowid"

/**
 * Moves every row of `table` whose `column` holds `from` to `to`. A row the kept identity already has under a unique
 * key folds into that twin: the twin keeps its values and takes the ones it lacks, what pointed at the row points at
 * the twin, and the row goes. A row with no twin is refused, so nothing is dropped unseen.
 */
const moveRows = (context: StoreContext, table: string, column: string, from: number, to: number): void => {
  const { database } = context
  const t = quoted(table)
  const c = quoted(column)
  database.prepare(`UPDATE OR IGNORE ${t} SET ${c} = ? WHERE ${c} = ?`).run(to, from)
  const key = rowKey(database, table)
  const left = database.prepare(`SELECT ${key} AS pk, * FROM ${t} WHERE ${c} = ?`).all(from)
  if (left.length === 0) return
  const keys = uniqueKeys(database, table, column)
  const fill = columnsOf(database, table)
    .map((one) => String(one.name))
    .filter((name) => name !== column && name !== "id")
  for (const row of left) {
    const twin = twinOf(database, table, column, to, row, keys)
    if (twin === undefined)
      throw new CliError("conflict", `${table}.${column}: a row of the old identity has no counterpart to merge into`, {
        reason: "identity.merge-conflict",
      })
    foldRow(context, table, key, fill, Number(row.pk), twin)
    for (const ref of foreignKeysTo(database, table)) moveRows(context, ref.table, ref.column, Number(row.pk), twin)
    database.prepare(`DELETE FROM ${t} WHERE ${key} = ?`).run(Number(row.pk))
  }
}

const twinOf = (
  database: CacheDatabase,
  table: string,
  column: string,
  to: number,
  row: Row,
  keys: UniqueKey[],
): number | undefined => {
  const key = rowKey(database, table)
  for (const unique of keys) {
    const others = unique.columns.filter((one) => one !== column)
    const found = database
      .prepare(
        `SELECT ${key} AS pk FROM ${quoted(table)} WHERE ${quoted(column)} = ?` +
          others.map((one) => ` AND ${quoted(one)} IS ?`).join("") +
          (unique.where ? ` AND (${unique.where})` : ""),
      )
      .get(to, ...others.map((one) => row[one] as never))
    if (found) return Number(found.pk)
  }
  return undefined
}

/** The twin keeps what it has; `account_identities` keeps the newest message and the address book mark of either. */
const foldRow = (context: StoreContext, table: string, key: string, fill: string[], from: number, to: number) => {
  const t = quoted(table)
  const latest = new Set(table === "account_identities" ? ["last_messaged_at", "address_book"] : [])
  const sets = fill.map((name) =>
    latest.has(name)
      ? `${quoted(name)} = max(coalesce(${quoted(name)}, 0), coalesce((SELECT o.${quoted(name)} FROM ${t} o WHERE o.${key} = ?), 0))`
      : `${quoted(name)} = coalesce(${quoted(name)}, (SELECT o.${quoted(name)} FROM ${t} o WHERE o.${key} = ?))`,
  )
  if (sets.length === 0) return
  context.database.prepare(`UPDATE ${t} SET ${sets.join(", ")} WHERE ${key} = ?`).run(...fill.map(() => from), to)
}

/** `provider:id` strings in the owner's open and decided proposals follow the identity. */
const renameInProposals = (database: CacheDatabase, provider: Provider, from: Id, to: Id): number[] => {
  const [old, renamed] = [`${provider}:${from}`, `${provider}:${to}`]
  const persons: number[] = []
  const rows = database
    .prepare(
      "SELECT id, payload FROM proposed_actions WHERE kind IN ('identity_link', 'identity_split') AND instr(payload, ?) > 0",
    )
    .all(JSON.stringify(old))
  for (const row of rows) {
    const payload = JSON.parse(String(row.payload)) as Record<string, unknown>
    for (const field of ["identity", "with"]) if (payload[field] === old) payload[field] = renamed
    if (Array.isArray(payload.identities))
      payload.identities = payload.identities.map((one) => (one === old ? renamed : one))
    if (Array.isArray(payload.persons)) for (const one of payload.persons) persons.push(Number(one))
    database
      .prepare("UPDATE proposed_actions SET payload = ? WHERE id = ?")
      .run(JSON.stringify(payload), Number(row.id))
  }
  return persons
}

const personOfIdentity = (database: CacheDatabase, identity: number): number | undefined => {
  const row = database.prepare("SELECT person_id FROM identity_links WHERE identity_id = ?").get(identity)
  return row ? Number(row.person_id) : undefined
}

/**
 * The provider now names one of its identities `to` instead of `from`. With no `to` stored, the identity takes the new
 * id. With `to` stored too, `from` merges into it: its people become one person (the owner's stays), and every row
 * that points at `from`, through a foreign key or an `<x>_type = 'identity'` pointer, points at `to`. Replaying it
 * changes nothing. Runs inside `write`.
 */
export const renameIdentity = (
  context: StoreContext,
  provider: Provider,
  from: Id,
  to: Id,
  by: string,
): IdentityRenameOutcome => {
  const { database } = context
  if (from === to) return "untouched"
  const find = database.prepare("SELECT * FROM identities WHERE provider = ? AND external_id = ?")
  const old = find.get(provider, from)
  if (!old) return "untouched"
  const oldId = Number(old.id)
  const kept = find.get(provider, to)
  const persons = renameInProposals(database, provider, from, to)
  if (!kept) {
    database.prepare("UPDATE identities SET external_id = ?, updated_at = ? WHERE id = ?").run(to, context.now(), oldId)
    settleLinks(database, persons)
    return "renamed"
  }
  const keptId = Number(kept.id)
  const [mine, theirs] = [personOfIdentity(database, oldId), personOfIdentity(database, keptId)]
  if (mine !== undefined && theirs !== undefined && mine !== theirs)
    persons.push(mergePerson(context, mine, theirs, { method: "identity-rename", by }))
  for (const { table, pointer } of pointerPairs(database)) {
    const where = `WHERE ${pointer}_type = 'identity' AND ${pointer}_id = ?`
    database.prepare(`UPDATE OR IGNORE ${quoted(table)} SET ${pointer}_id = ? ${where}`).run(keptId, oldId)
    database.prepare(`DELETE FROM ${quoted(table)} ${where}`).run(oldId)
  }
  for (const { table, column } of foreignKeysTo(database, "identities")) moveRows(context, table, column, oldId, keptId)
  const fill = ["username", "name", "bot", "phone_hmac", "metadata", "description", "email", "phone"]
  database
    .prepare(
      `UPDATE identities SET ${fill.map((name) => `${name} = coalesce(${name}, (SELECT o.${name} FROM identities o WHERE o.id = ?))`).join(", ")}, updated_at = ? WHERE id = ?`,
    )
    .run(...fill.map(() => oldId), context.now(), keptId)
  database.prepare("DELETE FROM identities WHERE id = ?").run(oldId)
  settleLinks(database, [...persons, ...(theirs === undefined ? [] : [theirs])])
  return "merged"
}

/**
 * `renameIdentity` for a run of pairs, in order, each in its own savepoint so a refused one leaves the others applied,
 * stopping once `lockMs` has passed so other processes get the write lock. Runs inside `write`.
 */
export const renameIdentities = (
  context: StoreContext,
  provider: Provider,
  pairs: readonly { from: Id; to: Id }[],
  { lockMs, by }: { lockMs: number; by: string },
): IdentityRenames => {
  const done: IdentityRenames = { taken: 0, renamed: 0, merged: 0, untouched: 0, refused: [] }
  const started = performance.now()
  for (const { from, to } of pairs) {
    if (done.taken > 0 && performance.now() - started >= lockMs) break
    done.taken += 1
    try {
      done[write(context.database, () => renameIdentity(context, provider, from, to, by))] += 1
    } catch (error) {
      done.refused.push({ from, to, error })
    }
  }
  return done
}
