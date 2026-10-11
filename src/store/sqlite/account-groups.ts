import { ACCOUNT_GROUPS, type AccountGroups, type Profiles } from "../../search/account-list.js"
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

const PROFILES = "profiles"

export const profilesOf = (database: CacheDatabase): Profiles => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(PROFILES)
  if (!row) return {}
  try {
    const value = JSON.parse(String(row.value)) as unknown
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Profiles) : {}
  } catch {
    return {}
  }
}

/** Written only when it changes: every run of every app records its profile, and most find it there already. */
export const saveProfile = (
  database: CacheDatabase,
  app: string,
  profile: string,
  key: { provider: string; account: string },
  now: number,
): void => {
  const profiles = profilesOf(database)
  const known = profiles[app]?.[profile]
  if (known?.provider === key.provider && known.account === key.account) return
  profiles[app] = { ...profiles[app], [profile]: { provider: key.provider, account: key.account } }
  database
    .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
    .run(PROFILES, JSON.stringify(profiles), now)
}
