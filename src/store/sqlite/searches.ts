import { CliError, singleLine } from "@wirecat/cli-base"
import type { StoreContext } from "./open.js"
import { toIso } from "./values.js"

/** Unnamed runs kept, newest first; a saved search is never pruned. */
export const HISTORY_KEPT = 1000

export type SearchCommand = "search" | "stats" | "message-top" | "author-top" | "admin-statistics"

/** What one run or one saved search is: `params` as canonical JSON, so the same run is the same text. */
export interface SearchRecord {
  command: SearchCommand
  params: string
  language: string
  version: number
  fieldsVersion: number
}

export interface StoredSearch {
  id: string
  name: string | null
  command: SearchCommand
  params: Record<string, unknown>
  language: string
  version: number
  fieldsVersion: number
  createdAt: string
  lastRunAt: string | null
  runs: number
}

const COLUMNS =
  "id, name, command, params, language, version, fields_version, created_at, updated_at, last_run_at, runs"

const searchOf = (row: Record<string, unknown>): StoredSearch => ({
  id: String(row.id),
  name: row.name == null ? null : String(row.name),
  command: String(row.command) as SearchCommand,
  params: JSON.parse(String(row.params)) as Record<string, unknown>,
  language: String(row.language),
  version: Number(row.version),
  fieldsVersion: Number(row.fields_version),
  createdAt: toIso(Number(row.created_at)) as string,
  lastRunAt: toIso(row.last_run_at == null ? null : Number(row.last_run_at)),
  runs: Number(row.runs),
})

export const recordRun = ({ database, now }: StoreContext, run: SearchRecord, saved?: string): void => {
  const at = now()
  database
    .prepare(
      `INSERT INTO searches (command, params, language, version, fields_version, created_at, updated_at, last_run_at, runs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (command, params) WHERE name IS NULL DO UPDATE SET runs = runs + 1, last_run_at = excluded.last_run_at, updated_at=excluded.updated_at`,
    )
    .run(run.command, run.params, run.language, run.version, run.fieldsVersion, at, at, at)
  database
    .prepare(
      `DELETE FROM searches WHERE name IS NULL AND id NOT IN
       (SELECT id FROM searches WHERE name IS NULL ORDER BY last_run_at DESC, id DESC LIMIT ?)`,
    )
    .run(HISTORY_KEPT)
  if (saved !== undefined)
    database.prepare("UPDATE searches SET runs = runs + 1, last_run_at = ? WHERE id = ?").run(at, Number(saved))
}

export const findSearch = ({ database }: StoreContext, reference: string): StoredSearch | undefined => {
  const row = /^\d+$/.test(reference)
    ? database.prepare(`SELECT ${COLUMNS} FROM searches WHERE id = ?`).get(Number(reference))
    : database.prepare(`SELECT ${COLUMNS} FROM searches WHERE name = ?`).get(reference)
  return row && searchOf(row)
}

const mustFind = (context: StoreContext, reference: string): StoredSearch => {
  const found = findSearch(context, reference)
  if (!found) throw new CliError("not_found", `no saved search or run "${singleLine(reference)}"`)
  return found
}

/** A name already taken is refused unless `replace`, which starts it afresh: new parameters, no runs. */
export const saveSearch = (
  context: StoreContext,
  name: string,
  search: SearchRecord,
  replace: boolean,
): StoredSearch => {
  const { database, now } = context
  const taken = findSearch(context, name)
  if (taken && !replace)
    throw new CliError("validation_error", `a saved search is already named "${name}" — --replace overwrites it`, {
      reason: "name.taken",
    })
  const values = [search.command, search.params, search.language, search.version, search.fieldsVersion, now()]
  if (taken)
    database
      .prepare(
        `UPDATE searches SET command = ?, params = ?, language = ?, version = ?, fields_version = ?, created_at = ?, updated_at = ?,
         last_run_at = NULL, runs = 0 WHERE id = ?`,
      )
      .run(...values, now(), Number(taken.id))
  else
    database
      .prepare(
        "INSERT INTO searches (command, params, language, version, fields_version, created_at, updated_at, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(...values, now(), name)
  return mustFind(context, name)
}

export const savedSearches = ({ database }: StoreContext): StoredSearch[] =>
  database.prepare(`SELECT ${COLUMNS} FROM searches WHERE name IS NOT NULL ORDER BY name`).all().map(searchOf)

/** Runs, newest first: unnamed ones and saved searches that have run. One more than `limit` says there are more. */
export const searchHistory = ({ database }: StoreContext, limit: number): StoredSearch[] =>
  database
    .prepare(`SELECT ${COLUMNS} FROM searches WHERE last_run_at IS NOT NULL ORDER BY last_run_at DESC, id DESC LIMIT ?`)
    .all(limit + 1)
    .map(searchOf)

export const deleteSearch = (context: StoreContext, reference: string): StoredSearch => {
  const found = mustFind(context, reference)
  context.database.prepare("DELETE FROM searches WHERE id = ?").run(Number(found.id))
  return found
}

/** Unnamed runs only; saved searches stay. */
export const clearHistory = ({ database }: StoreContext): number =>
  database.prepare("DELETE FROM searches WHERE name IS NULL").run().changes
