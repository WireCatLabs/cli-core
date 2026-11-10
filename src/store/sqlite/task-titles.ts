import { isLocator } from "../../domain/locator.js"
import type { CacheDatabase } from "../driver.js"
import { thingOf } from "./things.js"

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
 * placeholder, the stored title otherwise. Read time only, so a deleted message leaves nothing behind.
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
