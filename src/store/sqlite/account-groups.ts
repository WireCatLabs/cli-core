import { ACCOUNT_GROUPS, type AccountGroups, type Profiles } from "../../search/account-list.js"
import type { CacheDatabase } from "../driver.js"

/**
 * A value migration 31 stored as JSON text inside the object, as it did under SQLite 3.54, which drops the JSON type of
 * a subquery's result: read back as the object or list it holds.
 */
const unquoted = (value: unknown): unknown => {
  if (typeof value !== "string" || !/^\s*[[{]/u.test(value)) return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

/** None saved, or a value this build cannot read, is no groups: a search naming one then says it does not exist. */
export const accountGroupsOf = (database: CacheDatabase): AccountGroups => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(ACCOUNT_GROUPS)
  if (!row) return {}
  try {
    const value = JSON.parse(String(row.value)) as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value)
        .map(([name, members]) => [name, unquoted(members)] as const)
        .filter(
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
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).map(([app, profiles]) => [app, unquoted(profiles)])) as Profiles
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

export const forgetProfile = (database: CacheDatabase, app: string, profile: string, now: number): void => {
  const profiles = profilesOf(database)
  const own = profiles[app]
  if (own?.[profile] === undefined) return
  const { [profile]: _, ...rest } = own
  if (Object.keys(rest).length === 0) delete profiles[app]
  else profiles[app] = rest
  database
    .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
    .run(PROFILES, JSON.stringify(profiles), now)
}
