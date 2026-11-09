import { CliError } from "@wirecat/cli-base"
import { displayName, nameKey } from "../../domain/display-names.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { fold } from "../normalize.js"
import { mergedAwaySql } from "./merged-persons.js"
import { type ShownBecause, shownReasons } from "./person-ties.js"
import { mergedAssignees } from "./task-board.js"

export interface PeopleListOptions {
  /** Part of a name or username, at least 3 characters. */
  query?: string
  /** Also the people with no tie to the owner. */
  all?: boolean
  /** `tasks`: the owner, then by how many tasks name them, then by name. */
  sort?: "tasks" | "name"
  limit: number
  offset?: number
}

export interface ListedPerson {
  person: string
  /** As stored; `displayName` is what to show. */
  name: string | null
  displayName: string | null
  owner: boolean
  tasks: number
  username: string | null
  phone: string | null
  email: string | null
  /** Why they are shown; empty for someone hidden by default. */
  ties: ShownBecause[]
}

export interface PeopleList {
  items: ListedPerson[]
  hasMore: boolean
  /** Everyone the list holds over every page. */
  total: number
  /** The people matching that have no tie to the owner, shown only with `all`. */
  hidden: number
}

export interface SimilarPerson extends ListedPerson {
  /** The same name once case, quotes, punctuation and word order are set aside: maybe the same person. */
  sameName: boolean
}

const MIN_QUERY = 3

const ftsPhrase = (text: string) => `"${text.replaceAll('"', '""')}"`

const matching = (query: string | undefined): { sql: string; params: SqlValue[] } => {
  if (query === undefined) return { sql: "", params: [] }
  const text = query.trim()
  if (text.length < MIN_QUERY)
    throw new CliError("validation_error", `a people search takes at least ${MIN_QUERY} characters, got "${query}"`)
  return {
    sql:
      " AND (p.id IN (SELECT l.person_id FROM identity_links l WHERE l.identity_id IN " +
      "(SELECT rowid FROM identities_fts WHERE identities_fts MATCH ?)) OR p.name LIKE ? ESCAPE '\\')",
    params: [ftsPhrase(text), `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
  }
}

const firstOf = (column: string, provider: string) =>
  `(SELECT coalesce(i.${column}, CASE WHEN i.provider = '${provider}' THEN i.external_id END) FROM identity_links l ` +
  `JOIN identities i ON i.id = l.identity_id WHERE l.person_id = p.id ` +
  `AND (i.${column} IS NOT NULL OR i.provider = '${provider}') ORDER BY i.id LIMIT 1)`

const ROW =
  "p.id, p.name, p.owner, " +
  "(SELECT i.username FROM identity_links l JOIN identities i ON i.id = l.identity_id " +
  "WHERE l.person_id = p.id AND i.username IS NOT NULL ORDER BY i.id LIMIT 1) AS username, " +
  `${firstOf("phone", "phone")} AS phone, ${firstOf("email", "email")} AS email`

const TASK_COUNTS =
  "WITH merged AS (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS now FROM json_each(?)), " +
  "counts AS (SELECT coalesce(m.now, a.assignee_id) AS person, count(DISTINCT t.id) AS n FROM task_assignments a " +
  "JOIN tasks t ON t.id = a.task_id AND t.deleted_at IS NULL LEFT JOIN merged m ON m.id = a.assignee_id " +
  "WHERE a.assignee_type = 'person' GROUP BY 1)"

/** Sorted as read: wrapping quotes and spaces do not decide a name's place. */
const BY_NAME = "p.name IS NULL, ltrim(p.name, ' \"''«“„‘`') COLLATE NOCASE, p.id"

const listedOf = (row: Record<string, unknown>, ties: Map<number, ShownBecause[]>): ListedPerson => {
  const text = (value: unknown) => (value == null ? null : String(value))
  const id = Number(row.id)
  const name = text(row.name)
  const contact = { username: text(row.username), phone: text(row.phone), email: text(row.email) }
  return {
    person: `person:${id}`,
    name,
    displayName: displayName(name, contact),
    owner: Number(row.owner) === 1,
    tasks: Number(row.n ?? 0),
    ...contact,
    ties: ties.get(id) ?? [],
  }
}

/** Each person's row with their contact and task count, in the order given. */
const rowsOf = (database: CacheDatabase, people: readonly number[]): Record<string, unknown>[] => {
  if (people.length === 0) return []
  const byId = new Map(
    database
      .prepare(
        `${TASK_COUNTS} SELECT ${ROW}, coalesce(c.n, 0) AS n FROM persons p LEFT JOIN counts c ON c.person = p.id ` +
          "WHERE p.id IN (SELECT value FROM json_each(?))",
      )
      .all(mergedAssignees(database), JSON.stringify(people))
      .map((row) => [Number(row.id), row]),
  )
  return people.flatMap((person) => {
    const row = byId.get(person)
    return row === undefined ? [] : [row]
  })
}

/** People by name or by task count, the owner first; by default only those with a tie to the owner. */
export const listPeople = (database: CacheDatabase, options: PeopleListOptions): PeopleList => {
  const { all = false, sort = "tasks", limit, offset = 0 } = options
  const filter = matching(options.query)
  const reasons = shownReasons(database)
  const shown = JSON.stringify([...reasons.keys()])
  const live = `NOT ${mergedAwaySql("p")}${filter.sql}`
  const counted = database
    .prepare(
      "SELECT count(*) AS total, coalesce(sum(p.id NOT IN (SELECT value FROM json_each(?))), 0) AS hidden " +
        `FROM persons p WHERE ${live}`,
    )
    .get(shown, ...filter.params)
  const order = sort === "name" ? `p.owner DESC, ${BY_NAME}` : `p.owner DESC, n DESC, ${BY_NAME}`
  // Ids first: the contact columns are worked out for the page only, not for every row the sort reads.
  const ids = database
    .prepare(
      `${TASK_COUNTS} SELECT p.id, coalesce(c.n, 0) AS n FROM persons p LEFT JOIN counts c ON c.person = p.id ` +
        `WHERE ${live}${all ? "" : " AND p.id IN (SELECT value FROM json_each(?))"} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .all(mergedAssignees(database), ...filter.params, ...(all ? [] : [shown]), limit + 1, offset)
    .map((row) => Number(row.id))
  const page = ids.slice(0, limit)
  const hidden = Number(counted?.hidden ?? 0)
  return {
    items: rowsOf(database, page).map((row) => listedOf(row, reasons)),
    hasMore: ids.length > limit,
    total: Number(counted?.total ?? 0) - (all ? 0 : hidden),
    hidden,
  }
}

const words = (key: string | null): string[] => (key === null ? [] : key.split(" "))

/** Every typed word starts a word of the name, in any order: «iv pet» finds Petrov Ivan. */
const startsEach = (typed: string[], name: string | null) => {
  const own = words(nameKey(name))
  return typed.every((word) => own.some((one) => one.startsWith(word)))
}

/**
 * People whose name, or a name of one of their identities, has a word starting with each typed word, for a form
 * that adds a person: the same name first (maybe a duplicate), then those with a tie to the owner, then by name.
 */
export const similarPeople = (database: CacheDatabase, typed: string, limit: number): SimilarPerson[] => {
  const key = nameKey(typed)
  const wanted = words(key)
  const longest = wanted.reduce((a, b) => (b.length > a.length ? b : a), "")
  if (longest === "") return []
  const named = new Map<number, string[]>()
  const note = (person: number, name: unknown) => {
    if (typeof name === "string") named.set(person, [...(named.get(person) ?? []), name])
  }
  // A person added by hand has no identity to search; there are few, and SQLite folds only ASCII case.
  for (const row of database
    .prepare(
      "SELECT p.id, p.name FROM persons p WHERE p.name IS NOT NULL " +
        `AND NOT EXISTS (SELECT 1 FROM identity_links l WHERE l.person_id = p.id) AND NOT ${mergedAwaySql("p")}`,
    )
    .all())
    note(Number(row.id), row.name)
  const identityRows =
    longest.length >= MIN_QUERY
      ? database
          .prepare(
            "SELECT l.person_id AS person, i.name, i.username FROM identities_fts f JOIN identities i ON i.id = f.rowid " +
              "JOIN identity_links l ON l.identity_id = i.id WHERE identities_fts MATCH ?",
          )
          .all(ftsPhrase(longest))
      : database
          .prepare(
            "SELECT l.person_id AS person, i.name, i.username FROM identities i " +
              "JOIN identity_links l ON l.identity_id = i.id WHERE i.name_folded LIKE ? ESCAPE '\\'",
          )
          .all(`%${fold(longest).replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
  for (const row of identityRows) {
    note(Number(row.person), row.name)
    note(Number(row.person), row.username)
  }
  const found = [...named]
    .filter(([, names]) => names.some((name) => startsEach(wanted, name)))
    .map(([person, names]) => ({
      person,
      name: names[0] ?? "",
      same: names.some((name) => nameKey(name) === key),
    }))
  if (found.length === 0) return []
  const ties = shownReasons(database)
  const chosen = found
    .sort(
      (a, b) =>
        Number(b.same) - Number(a.same) ||
        Number(ties.has(b.person)) - Number(ties.has(a.person)) ||
        a.name.localeCompare(b.name) ||
        a.person - b.person,
    )
    .slice(0, limit)
  const sameName = new Map(chosen.map(({ person, same }) => [person, same]))
  return rowsOf(database, [...sameName.keys()]).map((row) => ({
    ...listedOf(row, ties),
    sameName: sameName.get(Number(row.id)) === true,
  }))
}
