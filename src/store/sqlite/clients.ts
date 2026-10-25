import { readFileSync } from "node:fs"
import type { CacheDatabase } from "../driver.js"

export const CLIENTS_SETTING = "clients"

/** A CLI that opened the store for writing: what it is and the newest store schema it speaks. */
export interface StoreClient {
  command: string
  version: string
  core: string
  speaks: number
  seenAt: number
}

const coreVersion = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"))
    return typeof manifest.version === "string" ? manifest.version : "unknown"
  } catch {
    return "unknown"
  }
})()

const clientOf = (value: unknown): StoreClient | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { command, version, core, speaks, seenAt } = value as Record<string, unknown>
  return typeof command === "string" &&
    typeof version === "string" &&
    typeof core === "string" &&
    Number.isSafeInteger(speaks) &&
    Number.isSafeInteger(seenAt)
    ? { command, version, core, speaks: speaks as number, seenAt: seenAt as number }
    : undefined
}

// A store built from a test's own migrations may have no settings table.
const hasSettings = (database: CacheDatabase) =>
  database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'store_settings'").get() !== undefined

/** Readable from any schema: `store_settings` is in the initial migration. */
export const storeClients = (database: CacheDatabase): StoreClient[] => {
  if (!hasSettings(database)) return []
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(CLIENTS_SETTING)
  if (!row) return []
  try {
    const value = JSON.parse(String(row.value)) as unknown
    return Array.isArray(value) ? value.flatMap((one) => clientOf(one) ?? []) : []
  } catch {
    return []
  }
}

/** Writes only when the CLI's version, cli-core or schema changed, or a day passed: every run calls it. */
export const recordClient = (
  database: CacheDatabase,
  { command, version, speaks }: { command: string; version: string; speaks: number },
  now: number,
): void => {
  if (!hasSettings(database)) return
  const stored = storeClients(database)
  const same = stored.find((one) => one.command === command)
  if (
    same &&
    same.version === version &&
    same.core === coreVersion &&
    same.speaks === speaks &&
    now - same.seenAt < 86_400_000
  )
    return
  const entry: StoreClient = { command, version, core: coreVersion, speaks, seenAt: now }
  database
    .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
    .run(CLIENTS_SETTING, JSON.stringify([...stored.filter((one) => one.command !== command), entry]), now)
}

const upgradeOf = (clients: readonly StoreClient[]) => clients.map(({ command }) => `\`${command} upgrade\``).join(", ")

/** The sentence an upgrade that raised the store's minimum prints: who can no longer open it, and what to run. */
export const lockedOutNotice = (
  clients: readonly StoreClient[],
  { command, schema, minCompatible }: { command?: string; schema: number; minCompatible: number },
): string | undefined => {
  const others = clients.filter((one) => one.command !== command)
  const behind = others.filter(({ speaks }) => speaks < minCompatible)
  const named = behind.map(({ command, version }) => `${command} ${version}`).join(", ")
  if (behind.length)
    return `the store moved to schema ${schema}; ${named} can no longer open it until upgraded — run ${upgradeOf(behind)}`
  // A CLI that has not opened the store since clients were recorded is unknown here, but may still be behind.
  if (!others.length)
    return (
      `the store moved to schema ${schema}; every other WireCat CLI that uses it needs a version that speaks it — ` +
      "run `<cli> upgrade` for each"
    )
  return undefined
}

/** Added to a refusal: this tool's own command, and the CLI that moved the store, so the owner knows what to run. */
export const refusalAdvice = (clients: readonly StoreClient[], command: string | undefined, schema: number) => {
  const mover = clients
    .filter(({ speaks, command: other }) => speaks >= schema && other !== command)
    .sort((a, b) => b.seenAt - a.seenAt)[0]
  const own = command ? `run \`${command} upgrade\`` : "upgrade this tool"
  return mover ? `${own} (${mover.command} ${mover.version} moved the store to schema ${schema})` : own
}
