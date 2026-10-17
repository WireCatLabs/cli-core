import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"

/**
 * How many tasks the task rules may open per chat on an account's first pass after a sync. 0 by default (owner,
 * 2026-10-17): a first sync reads history, and history is the owner's to dig into with `tasks apply`, not ours.
 */
export const DEFAULT_FIRST_PASS_PER_CHAT = 0

const KEY = "taskFirstPassPerChat"

export const firstPassPerChatOf = (value: string, setting = "task_first_pass_per_chat"): number => {
  const n = Number(value.trim())
  if (value.trim() === "" || !Number.isInteger(n) || n < 0 || n > 1000)
    throw new CliError("validation_error", `${setting} takes a whole number from 0 to 1000 — not "${value}"`)
  return n
}

/** What `config set task_first_pass_per_chat` saved; `undefined` where the default applies. */
export const savedFirstPassPerChat = (database: CacheDatabase): number | undefined => {
  const value = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(KEY)?.value
  return value == null ? undefined : Number(value)
}

/** `null` goes back to the default. */
export const saveFirstPassPerChat = (database: CacheDatabase, value: number | null, now: number): void => {
  if (value === null) database.prepare("DELETE FROM store_settings WHERE key = ?").run(KEY)
  else
    database
      .prepare(
        "INSERT INTO store_settings (key, value, at) VALUES (?, ?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at",
      )
      .run(KEY, String(value), now)
}
