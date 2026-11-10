import { CliError } from "@wirecat/cli-base"
import { type CrmScopeSetting, isCrmUserId, normalCrmUserId } from "../../domain/crm.js"
import type { CacheDatabase } from "../driver.js"
import type { AccountKey } from "../types.js"

/** `reported`: what a CRM account says is a relationship nobody confirmed; `review`: it waits as a proposal. */
export const CRM_LINK_MODES = ["reported", "review"] as const
export type CrmLinkMode = (typeof CRM_LINK_MODES)[number]

/** What a CRM company type may mean: the company buys from the own company, sells to it, or partners with it. */
export const COMPANY_TYPE_MEANINGS = ["customer-of", "supplier", "partner-of"] as const
export type CompanyTypeMeaning = (typeof COMPANY_TYPE_MEANINGS)[number]

/** `mine`: only the deals and leads of the sign-in's own user and of the `unassigned` users; `all`: every one. */
export const CRM_SCOPES = ["mine", "all"] as const

const NAMES = ["links", "company-types", "scope", "unassigned", "self"] as const
type CrmSettingName = (typeof NAMES)[number]
const SETTING = new RegExp(`^crm\\.([a-z0-9-]+):(.+)\\.(${NAMES.join("|")})$`)

export const crmSettingKey = (key: AccountKey, name: CrmSettingName): string =>
  `crm.${key.provider}:${key.account}.${name}`

/** The account and the setting a key names; a portal's account may hold dots, so it is read from both ends. */
export const parseCrmSetting = (setting: string): { key: AccountKey; name: CrmSettingName } | undefined => {
  const match = SETTING.exec(setting)
  return match
    ? { key: { provider: match[1] as string, account: match[2] as string }, name: match[3] as CrmSettingName }
    : undefined
}

const stored = (database: CacheDatabase, setting: string): unknown => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(setting)
  if (!row) return undefined
  try {
    return JSON.parse(String(row.value))
  } catch {
    return undefined
  }
}

/** A value this build cannot read is the default: the CRM's relationships stay reported. */
export const crmLinkMode = (database: CacheDatabase, key: AccountKey): CrmLinkMode => {
  const value = stored(database, crmSettingKey(key, "links"))
  return value === "review" ? "review" : "reported"
}

/** Only the owner's mapping gives a company type a meaning; none by default. */
export const crmCompanyTypes = (database: CacheDatabase, key: AccountKey): Record<string, CompanyTypeMeaning> => {
  const value = stored(database, crmSettingKey(key, "company-types"))
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, CompanyTypeMeaning] =>
      (COMPANY_TYPE_MEANINGS as readonly unknown[]).includes(entry[1]),
    ),
  )
}

/** Kept as stored, a malformed one too: the sync refuses it by name rather than copy fewer deals without a word. */
const userIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : []

/** `mine` unless the owner chose `all`: a sync never copies other people's deals without being asked. */
export const crmScope = (database: CacheDatabase, key: AccountKey): CrmScopeSetting => {
  const scope = stored(database, crmSettingKey(key, "scope"))
  if (scope === "all") return { mode: "all" }
  return { mode: "mine", also: userIds(stored(database, crmSettingKey(key, "unassigned"))), explicit: scope === "mine" }
}

const picked = (name: string, text: string, values: readonly string[]) => {
  if (!values.includes(text))
    throw new CliError("validation_error", `a CRM account's ${name} setting is ${values.join(" or ")}`)
  return text
}

/** The users whose deals and leads scope mine keeps, whatever the scope is now: `self` and the `unassigned` list. */
export const crmScopeUsers = (database: CacheDatabase, key: AccountKey): string[] => {
  const self = crmOwnUser(database, key)
  return [...new Set([...(self ? [self] : []), ...userIds(stored(database, crmSettingKey(key, "unassigned")))])]
}

/**
 * `links`: reported or review; `scope`: mine or all; `unassigned`: the CRM's user ids, comma-separated;
 * `company-types`: `TYPE=meaning` pairs, comma-separated.
 */
/** The CRM user whose deals the account's copy holds: the first sync's sign-in, until the owner unsets it. */
export const crmOwnUser = (database: CacheDatabase, key: AccountKey): string | undefined => {
  const value = stored(database, crmSettingKey(key, "self"))
  return typeof value === "string" && value ? value : undefined
}

export const parseCrmSettingValue = (name: CrmSettingName, value: string): unknown => {
  const text = value.trim()
  if (name === "links") return picked(name, text, CRM_LINK_MODES)
  if (name === "scope") return picked(name, text, CRM_SCOPES)
  if (name === "self") {
    if (!isCrmUserId(text))
      throw new CliError("validation_error", `self takes the CRM's numeric user id: not "${text}"`)
    return normalCrmUserId(text)
  }
  if (name === "unassigned") {
    const ids = [...new Set(text.split(",").map((one) => one.trim()))]
    const bad = ids.find((one) => !isCrmUserId(one))
    if (bad !== undefined)
      throw new CliError(
        "validation_error",
        `unassigned takes the CRM's numeric user ids, comma-separated: not "${bad}"`,
      )
    return ids
  }
  const pairs = text
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
  const map: Record<string, CompanyTypeMeaning> = {}
  for (const pair of pairs) {
    const [type, meaning] = pair.split("=").map((part) => part.trim())
    if (!type || !(COMPANY_TYPE_MEANINGS as readonly string[]).includes(meaning ?? ""))
      throw new CliError(
        "validation_error",
        `company-types takes TYPE=meaning pairs, the meaning ${COMPANY_TYPE_MEANINGS.join(", ")}: not "${pair}"`,
      )
    map[type] = meaning as CompanyTypeMeaning
  }
  return map
}

export const saveCrmSetting = (database: CacheDatabase, setting: string, value: unknown, now: number): void => {
  if (value === undefined) database.prepare("DELETE FROM store_settings WHERE key = ?").run(setting)
  else
    database
      .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
      .run(setting, JSON.stringify(value), now)
}

const settingValue = (database: CacheDatabase, key: AccountKey, name: CrmSettingName): unknown => {
  if (name === "links") return crmLinkMode(database, key)
  if (name === "company-types") return crmCompanyTypes(database, key)
  if (name === "scope") return crmScope(database, key).mode
  if (name === "self") return crmOwnUser(database, key) ?? null
  return userIds(stored(database, crmSettingKey(key, name)))
}

export const crmSettingsOf = (database: CacheDatabase): { setting: string; value: unknown }[] =>
  database
    .prepare("SELECT key, value FROM store_settings WHERE key LIKE 'crm.%' ORDER BY key")
    .all()
    .flatMap((row) => {
      const parsed = parseCrmSetting(String(row.key))
      if (!parsed) return []
      return [{ setting: String(row.key), value: settingValue(database, parsed.key, parsed.name) }]
    })
