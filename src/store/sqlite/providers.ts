import {
  addProvider,
  importedOf,
  kindsOfEntry,
  type ProviderEntry,
  providerEntryOf,
  unitedKinds,
  useStoredProviders,
} from "../../domain/providers.js"
import type { CacheDatabase } from "../driver.js"
import { write } from "./transaction.js"

export const PROVIDERS_SETTING = "providers"

/** The entries as stored, unchecked: a newer CLI may have written a kind this build does not know. */
export const storedProvidersOf = (database: CacheDatabase): unknown[] => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(PROVIDERS_SETTING)
  if (!row) return []
  try {
    const value = JSON.parse(String(row.value)) as unknown
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

/** Called on every open: the module state follows the store the process opened last. */
export const loadProviders = (database: CacheDatabase): void => {
  useStoredProviders(storedProvidersOf(database))
}

const nameOf = (stored: unknown) =>
  typeof stored === "object" && stored !== null ? (stored as { name?: unknown }).name : undefined

/**
 * Writes `entry` over the stored one of its name and loads the result. Every run of every CLI calls it, so it
 * writes only when the entry changed. Entries this build cannot read stay stored for the CLIs that can.
 */
/**
 * The entry with what the stored one of its name held beyond it: another build's kinds are never dropped, and
 * `imported` is kept as `importedOf` rules, so it can be neither stripped nor added later.
 */
const keptBeside = (entry: ProviderEntry, stored: readonly unknown[]): ProviderEntry => {
  const found = stored.find((one) => nameOf(one) === entry.name)
  let held: ProviderEntry | undefined
  try {
    held = found === undefined ? undefined : providerEntryOf(found)
  } catch {
    held = undefined
  }
  const imported = importedOf(entry, held)
  const { imported: _given, ...rest } = entry
  const kinds =
    held && held.kind === entry.kind ? unitedKinds(kindsOfEntry(held), kindsOfEntry(entry)) : kindsOfEntry(entry)
  return { ...rest, ...(kinds.length > 1 ? { kinds } : {}), ...(imported ? { imported: true } : {}) }
}

export const registerProvider = (database: CacheDatabase, value: ProviderEntry, now: number): void => {
  write(database, () => {
    const stored = storedProvidersOf(database)
    const entry = keptBeside(providerEntryOf(value), stored)
    const others = stored.filter((one) => nameOf(one) !== entry.name)
    try {
      useStoredProviders(others)
      addProvider(entry)
    } catch (error) {
      useStoredProviders(stored)
      throw error
    }
    if (stored.some((one) => JSON.stringify(one) === JSON.stringify(entry))) return
    database
      .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
      .run(PROVIDERS_SETTING, JSON.stringify([...others, entry]), now)
  })
}
