import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"

/** How an agent's close of a task is taken: `allowed` off makes every agent close a suggestion. */
export interface AgentCloseSettings {
  allowed: boolean
  /** The certainty, 0–1, an agent must state for its close to close the task. */
  min: number
}

/**
 * Agents rate themselves high and coarsely; 0.8 is where "probably" ends and "maybe" begins. A close cannot be
 * undone, so a hedged one waits on the owner.
 */
export const DEFAULT_AGENT_CLOSE: AgentCloseSettings = { allowed: true, min: 0.8 }

const ALLOWED = "taskAgentClose"
const MIN = "taskAgentCloseMin"

/** An agent's close the owner has to confirm or reject; the task stays open meanwhile. */
export interface CloseSuggestion {
  as: "done" | "dismissed"
  /** The agent's name. */
  by: string
  certainty: number
  reason: string | null
  at: string
}

export const certaintyOf = (value: number, what = "certainty"): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new CliError("validation_error", `${what} takes a number from 0 to 1 — not ${String(value)}`)
  return value
}

/** What `config set task_agent_close*` saved, field by field; `undefined` where the default applies. */
export const savedAgentClose = (database: CacheDatabase): Partial<AgentCloseSettings> => {
  const value = (key: string) => database.prepare("SELECT value FROM store_settings WHERE key = ?").get(key)?.value
  const allowed = value(ALLOWED)
  const min = value(MIN)
  return {
    ...(allowed == null ? {} : { allowed: String(allowed) === "on" }),
    ...(min == null ? {} : { min: Number(min) }),
  }
}

export const storeAgentClose = (database: CacheDatabase): AgentCloseSettings => ({
  ...DEFAULT_AGENT_CLOSE,
  ...savedAgentClose(database),
})

/** `null` goes back to the default for that field; a field left out stays as it is. */
export const saveAgentClose = (
  database: CacheDatabase,
  change: { allowed?: boolean | null; min?: number | null },
  now: number,
): void => {
  const put = (key: string, value: string | null) => {
    if (value === null) database.prepare("DELETE FROM store_settings WHERE key = ?").run(key)
    else
      database
        .prepare(
          "INSERT INTO store_settings (key, value, at) VALUES (?, ?, ?) " +
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at",
        )
        .run(key, value, now)
  }
  if (change.allowed !== undefined) put(ALLOWED, change.allowed === null ? null : change.allowed ? "on" : "off")
  if (change.min !== undefined) put(MIN, change.min === null ? null : String(certaintyOf(change.min)))
}

export const closeSuggestionOf = (database: CacheDatabase, row: Record<string, unknown>): CloseSuggestion | null => {
  if (row.close_suggested_as == null) return null
  const name =
    row.close_suggested_by_type === "bot"
      ? database.prepare("SELECT name FROM bots WHERE id = ?").get(Number(row.close_suggested_by_id))?.name
      : "owner"
  return {
    as: row.close_suggested_as as CloseSuggestion["as"],
    by: String(name ?? "agent"),
    certainty: Number(row.close_suggested_certainty),
    reason: row.close_suggested_reason == null ? null : String(row.close_suggested_reason),
    at: new Date(Number(row.close_suggested_at)).toISOString(),
  }
}

export const SUGGESTION_COLUMNS = [
  "close_suggested_as",
  "close_suggested_by_type",
  "close_suggested_by_id",
  "close_suggested_certainty",
  "close_suggested_reason",
  "close_suggested_at",
] as const

/** A close leaves them empty: nothing waits on the owner once the task is closed. */
export const CLEAR_SUGGESTION = SUGGESTION_COLUMNS.map((column) => `${column} = NULL`).join(", ")
