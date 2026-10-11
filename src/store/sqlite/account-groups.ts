import type { AccountGroups } from "../../search/account-list.js"
import { ACCOUNT_GROUPS } from "../../search/account-list.js"
import type { CacheDatabase } from "../driver.js"

/** None saved, or a value this build cannot read, is no groups: a search naming one then says it does not exist. */
export const accountGroupsOf = (database: CacheDatabase): AccountGroups => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(ACCOUNT_GROUPS)
  if (!row) return {}
  try {
    const value = JSON.parse(String(row.value)) as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string[]] =>
          Array.isArray(entry[1]) && entry[1].every((member) => typeof member === "string"),
      ),
    )
  } catch {
    return {}
  }
}
