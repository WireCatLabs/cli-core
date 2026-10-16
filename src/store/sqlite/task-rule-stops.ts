import type { CacheDatabase } from "../driver.js"
import type { AccountKey } from "../types.js"

// One row per account in store_settings: the task rules are a store-wide pass, not a messenger's state.
const keyOf = ({ provider, account }: AccountKey) => `task_rules_until:${provider}:${account}`

export const taskRulesStop = (database: CacheDatabase, account: AccountKey): string | null => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(keyOf(account))
  return row ? (JSON.parse(String(row.value)) as string) : null
}

export const setTaskRulesStop = (database: CacheDatabase, account: AccountKey, until: string, now: number): void => {
  database
    .prepare(
      "INSERT INTO store_settings (key, value, at) VALUES (?, ?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at",
    )
    .run(keyOf(account), JSON.stringify(until), now)
}
