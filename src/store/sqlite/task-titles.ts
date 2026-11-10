import { isLocator } from "../../domain/locator.js"
import type { CacheDatabase } from "../driver.js"
import { folded } from "./folded.js"
import { thingOf } from "./things.js"
import { writeBatch } from "./transaction.js"

type Row = Record<string, unknown>

const MAX_TITLE = 120

/** The title a rule gives a task it finds in a message: no message text is stored, so it is only a reference. */
export const placeholderTitleOf = (row: Row) => `${String(row.type)} — ${String(row.source_locator ?? "")}`

/** Same test in SQL, against a `tasks` row. */
export const PLACEHOLDER_TITLE_SQL = "title = type || ' — ' || coalesce(source_locator, '')"

const firstLine = (text: string) => {
  const line = text
    .split(/\r?\n/)
    .find((one) => one.trim() !== "")
    ?.trim()
  if (line === undefined) return undefined
  if (line.length <= MAX_TITLE) return line
  const cut = line.slice(0, MAX_TITLE)
  const space = cut.lastIndexOf(" ")
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, "")}…`
}

/**
 * What to show as a task's title: the first line of its source message while the stored title is still the
 * placeholder, the stored title otherwise. Store version 65 stored it once for the tasks found before it; a task found
 * since gets it only when read, so its title goes back to the placeholder once its message is deleted.
 */
export const displayTitleOf = (database: CacheDatabase, row: Row): string => {
  const stored = String(row.title)
  const locator = row.source_locator
  if (stored !== placeholderTitleOf(row) || typeof locator !== "string" || !locator.startsWith("msg:")) return stored
  if (!isLocator(locator)) return stored
  try {
    const thing = thingOf(database, locator)
    if (thing?.type !== "message") return stored
    const message = database.prepare("SELECT text FROM messages WHERE id = ? AND deleted_at IS NULL").get(thing.id)
    return (typeof message?.text === "string" ? firstLine(message.text) : undefined) ?? stored
  } catch {
    return stored
  }
}

/** Set by store version 65 and deleted once every found task's title is stored. */
export const FOUND_TASK_TITLES_TO_FILL = "found_task_titles_to_fill"

/**
 * Stores the title `displayTitleOf` shows for each live found task still titled `<kind> — <source>`, so it stays
 * when the message is deleted. One short write per batch; a task whose message is missing, deleted or empty keeps
 * its title. A failure keeps the key for the next open and only warns.
 */
export const fillFoundTaskTitles = (
  database: CacheDatabase,
  warn: (line: string) => void,
  { batch = 500 }: { batch?: number } = {},
): number => {
  if (!database.prepare("SELECT 1 AS found FROM store_settings WHERE key = ?").get(FOUND_TASK_TITLES_TO_FILL)) return 0
  const next = database.prepare(
    "SELECT id, type, title, source_locator FROM tasks WHERE id > ? AND package_id IS NOT NULL AND deleted_at IS NULL " +
      `AND source_locator LIKE 'msg:%' AND ${PLACEHOLDER_TITLE_SQL} ORDER BY id LIMIT ?`,
  )
  const store = database.prepare(
    `UPDATE tasks SET title = ?, title_folded = ? WHERE id = ? AND ${PLACEHOLDER_TITLE_SQL}`,
  )
  let filled = 0
  let after = 0
  try {
    for (;;) {
      const rows = writeBatch(database, () => {
        const page = next.all(after, batch)
        for (const row of page) {
          const title = displayTitleOf(database, row)
          if (title !== String(row.title)) filled += store.run(title, folded(title), Number(row.id)).changes
        }
        if (page.length < batch)
          database.prepare("DELETE FROM store_settings WHERE key = ?").run(FOUND_TASK_TITLES_TO_FILL)
        return page
      })
      if (rows.length < batch) return filled
      after = Number(rows.at(-1)?.id)
    }
  } catch (error) {
    warn(`could not store the titles of found tasks; the next open tries again: ${String(error)}`)
    return filled
  }
}
