import { DEFAULT_TASK_CATEGORIES, storedTaskCategories, type TaskCategory } from "../../domain/task-categories.js"
import type { CacheDatabase } from "../driver.js"

const SETTING = "taskCategories"

/** What `config set task_categories.*` saved; `undefined` while the default list applies. */
export const savedTaskCategories = (database: CacheDatabase): TaskCategory[] | undefined => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(SETTING)
  return row ? storedTaskCategories(String(row.value)) : undefined
}

/** The list every rule, `tasks add` and `tasks plan` take a category from: one per store, so tg, max and memo agree. */
export const storeTaskCategories = (database: CacheDatabase): readonly TaskCategory[] =>
  savedTaskCategories(database) ?? DEFAULT_TASK_CATEGORIES

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
