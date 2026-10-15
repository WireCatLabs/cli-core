import { normalizedValue, typedPhone } from "../../domain/mentions.js"
import { DEFAULT_PHONE_COUNTRIES, type PhoneCountry, parsePhoneCountries } from "../../domain/phones.js"
import type { CacheDatabase } from "../driver.js"

const SETTING = "phoneCountries"

/** What `config set phone_countries` saved; `undefined` while the default applies, or when a newer tool saved one. */
export const savedPhoneCountries = (database: CacheDatabase): PhoneCountry[] | undefined => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(SETTING)
  if (!row) return undefined
  try {
    return parsePhoneCountries((JSON.parse(String(row.value)) as string[]).join(","))
  } catch {
    return undefined
  }
}

/** The countries every write and search reads a number without `+` in. */
export const storePhoneCountries = (database: CacheDatabase): readonly PhoneCountry[] =>
  savedPhoneCountries(database) ?? DEFAULT_PHONE_COUNTRIES

export const saveStorePhoneCountries = (
  database: CacheDatabase,
  countries: readonly PhoneCountry[] | undefined,
  now: number,
): void => {
  if (countries === undefined) {
    database.prepare("DELETE FROM store_settings WHERE key = ?").run(SETTING)
    return
  }
  database
    .prepare(
      "INSERT INTO store_settings (key, value, at) VALUES (?, ?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at",
    )
    .run(SETTING, JSON.stringify(countries), now)
}

/**
 * SQL for a typed value against `mn.value`: the stored form, and for a phone also every stored spelling that
 * ends with its national number — the same number saved before `phone_countries` gave it a country code.
 */
export const valueMatch = (database: CacheDatabase, typed: string): { sql: string; params: string[] } => {
  const phoneCountries = storePhoneCountries(database)
  const phone = typedPhone(typed, { phoneCountries })
  if (phone?.national)
    return {
      sql: "(mn.value = ? OR (mn.kind = 'phone' AND mn.value LIKE ?))",
      params: [phone.value, `%${phone.national}`],
    }
  return { sql: "mn.value = ?", params: [phone?.value ?? normalizedValue(typed, { phoneCountries })] }
}
