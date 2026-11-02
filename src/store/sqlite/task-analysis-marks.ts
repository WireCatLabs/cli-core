import type { Id } from "../../domain/models.js"
import type { CacheDatabase } from "../driver.js"
import type { AccountKey, TaskAnalysisMark, TaskAnalysisMarkWrite } from "../types.js"

// In store_settings beside task_rules_until, so backup and restore carry it and it needs no migration.
const prefixOf = ({ provider, account }: AccountKey) => `task_analysis:${provider}:${account}:`

type Saved = Omit<TaskAnalysisMark, "chatId" | "at">

const markOf = (prefix: string, row: Record<string, unknown>): TaskAnalysisMark => ({
  chatId: String(row.key).slice(prefix.length),
  ...(JSON.parse(String(row.value)) as Saved),
  at: new Date(Number(row.at)).toISOString(),
})

export const taskAnalysisMarks = (database: CacheDatabase, account: AccountKey): TaskAnalysisMark[] => {
  const prefix = prefixOf(account)
  return database
    .prepare("SELECT key, value, at FROM store_settings WHERE substr(key, 1, ?) = ? ORDER BY at DESC")
    .all(prefix.length, prefix)
    .map((row) => markOf(prefix, row))
}

export const taskAnalysisMark = (
  database: CacheDatabase,
  account: AccountKey,
  chatId: Id,
): TaskAnalysisMark | undefined => {
  const prefix = prefixOf(account)
  const row = database.prepare("SELECT key, value, at FROM store_settings WHERE key = ?").get(prefix + chatId)
  return row ? markOf(prefix, row) : undefined
}

/** `checked`: the whole stretch through `checkedThrough` was read just now, by this store's clock. */
export const setTaskAnalysisMark = (
  database: CacheDatabase,
  account: AccountKey,
  { chatId, checked, ...saved }: TaskAnalysisMarkWrite,
  now: number,
): void => {
  const checkedAt = checked ? new Date(now).toISOString() : taskAnalysisMark(database, account, chatId)?.checkedAt
  database
    .prepare(
      "INSERT INTO store_settings (key, value, at) VALUES (?, ?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at",
    )
    .run(
      prefixOf(account) + chatId,
      JSON.stringify({ ...saved, checkedAt: checkedAt ?? new Date(now).toISOString() } satisfies Saved),
      now,
    )
}
