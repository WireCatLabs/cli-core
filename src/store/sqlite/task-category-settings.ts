import {
  DEFAULT_TASK_CATEGORIES,
  storedTaskCategories,
  type TaskCategory,
  type UnlistedCategory,
} from "../../domain/task-categories.js"
import type { CacheDatabase } from "../driver.js"

const SETTING = "taskCategories"

/** The list an older build saved with `config set task_categories.*`; `undefined` when none was. */
export const savedTaskCategories = (database: CacheDatabase): TaskCategory[] | undefined => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(SETTING)
  return row ? storedTaskCategories(String(row.value)) : undefined
}

/** The base the shared config file's `task_categories` edits: a list an older build saved, else the default. */
export const storeTaskCategories = (database: CacheDatabase): readonly TaskCategory[] =>
  savedTaskCategories(database) ?? DEFAULT_TASK_CATEGORIES

/** Categories tasks still carry that the list no longer holds, with how many tasks of each are open. Store-wide. */
export const unlistedTaskCategories = (database: CacheDatabase, list: readonly TaskCategory[]): UnlistedCategory[] => {
  const listed = new Set(list.map(({ name }) => name))
  return database
    .prepare(
      "SELECT category, COUNT(*) AS total, SUM(status NOT IN ('done', 'dismissed')) AS open FROM tasks " +
        "WHERE category IS NOT NULL AND deleted_at IS NULL GROUP BY category ORDER BY category",
    )
    .all()
    .map((row) => ({ name: String(row.category), open: Number(row.open), total: Number(row.total) }))
    .filter(({ name }) => !listed.has(name))
}

/** `undefined` goes back to the default list. */
export const saveTaskCategories = (
  database: CacheDatabase,
  categories: readonly TaskCategory[] | undefined,
  now: number,
): void => {
  if (categories === undefined) {
    database.prepare("DELETE FROM store_settings WHERE key = ?").run(SETTING)
    return
  }
  database
    .prepare(
      "INSERT INTO store_settings (key, value, at) VALUES (?, ?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at",
    )
    .run(SETTING, JSON.stringify(categories), now)
}
