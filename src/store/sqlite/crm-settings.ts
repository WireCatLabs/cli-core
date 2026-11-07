import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"
import type { AccountKey } from "../types.js"

/** `reported`: what a CRM account says is a relationship nobody confirmed; `review`: it waits as a proposal. */
export const CRM_LINK_MODES = ["reported", "review"] as const
export type CrmLinkMode = (typeof CRM_LINK_MODES)[number]

/** What a CRM company type may mean: the company buys from the own company, sells to it, or partners with it. */
export const COMPANY_TYPE_MEANINGS = ["customer-of", "supplier", "partner-of"] as const
export type CompanyTypeMeaning = (typeof COMPANY_TYPE_MEANINGS)[number]

const NAMES = ["links", "company-types"] as const
type CrmSettingName = (typeof NAMES)[number]

export const crmSettingKey = (key: AccountKey, name: CrmSettingName): string =>
  `crm.${key.provider}:${key.account}.${name}`

/** The account and the setting a key names; a portal's account may hold dots, so it is read from both ends. */
export const parseCrmSetting = (setting: string): { key: AccountKey; name: CrmSettingName } | undefined => {
  const match = /^crm\.([a-z0-9-]+):(.+)\.(links|company-types)$/.exec(setting)
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

/** `links`: reported or review; `company-types`: `TYPE=meaning` pairs, comma-separated. */
export const parseCrmSettingValue = (name: CrmSettingName, value: string): unknown => {
  const text = value.trim()
  if (name === "links") {
    if (!(CRM_LINK_MODES as readonly string[]).includes(text))
      throw new CliError("validation_error", `a CRM account's links setting is ${CRM_LINK_MODES.join(" or ")}`)
    return text
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

/** Every CRM setting the store holds, for `config show`. */
export const crmSettingsOf = (database: CacheDatabase): { setting: string; value: unknown }[] =>
  database
    .prepare("SELECT key, value FROM store_settings WHERE key LIKE 'crm.%' ORDER BY key")
    .all()
    .flatMap((row) => {
      const parsed = parseCrmSetting(String(row.key))
      if (!parsed) return []
      return [
        {
          setting: String(row.key),
          value: parsed.name === "links" ? crmLinkMode(database, parsed.key) : crmCompanyTypes(database, parsed.key),
        },
      ]
    })
