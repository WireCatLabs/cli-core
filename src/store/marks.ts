import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { isCliFailure, isStoreDamage } from "../errors/failures.js"
import type { StoreHealth } from "./health.js"
import { refuseOwnerStoreInTests } from "./path.js"

/**
 * Both marks live beside the store, not in it: the store may be the file that cannot be read. Each holds no content,
 * only times, command names and SQLite's own message.
 */
export const damageMarkPath = (store: string): string => `${store}.damaged.json`
export const healthMarkPath = (store: string): string => `${store}.health.json`

/** A run saw SQLite say the store is damaged. Every writable open refuses while it names the file in place. */
export interface DamageMark {
  at: string
  command: string
  cli_version?: string
  run_id?: string
  error: string
  /** The file it was seen in: a store restored, reset or recovered since is another file, and the mark is stale. */
  inode: number
}

/** The newest deep check of the store, and the time of the newest one that passed: the last known good. */
export interface HealthMark {
  checked_at: string
  ok: boolean
  problems: number
  schema: number | null
  cli: string
  cli_version?: string
  last_ok_at: string | null
}

const inodeOf = (store: string) => statSync(store, { throwIfNoEntry: false })?.ino

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

const ownerStoreInTests = (store: string) => {
  try {
    refuseOwnerStoreInTests(store)
    return false
  } catch {
    return true
  }
}

/** SQLite's own failure under a `store.damaged` CliError, or the error itself; the mark's own refusal has none. */
const sqliteFailure = (error: unknown): unknown =>
  isCliFailure(error) && error.details?.reason === "store.damaged" ? error.cause : error

/**
 * Leaves the damage mark when `error` is SQLite saying the store is damaged; the first sighting is kept. Never
 * throws: the failure being reported matters more than the mark.
 */
export const markStoreDamaged = (
  error: unknown,
  {
    store,
    command,
    version,
    runId,
    now = Date.now,
  }: { store: string; command: string; version?: string; runId?: string; now?: () => number },
): boolean => {
  const failure = sqliteFailure(error)
  if (!isStoreDamage(failure) || ownerStoreInTests(store)) return false
  const inode = inodeOf(store)
  if (inode === undefined) return false
  const mark: DamageMark = {
    at: new Date(now()).toISOString(),
    command,
    ...(version ? { cli_version: version } : {}),
    ...(runId ? { run_id: runId } : {}),
    error: (failure as Error).message.slice(0, 500),
    inode,
  }
  try {
    writeFileSync(damageMarkPath(store), `${JSON.stringify(mark, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** The mark, or null; a mark left by another file at this path is removed. An unreadable mark still counts. */
export const readDamageMark = (store: string): DamageMark | null => {
  const path = damageMarkPath(store)
  let mark: DamageMark | null
  try {
    mark = readJson<DamageMark>(path)
  } catch {
    return { at: "unknown", command: "unknown", error: `${path} cannot be read`, inode: inodeOf(store) ?? 0 }
  }
  if (mark === null) return null
  if (mark.inode !== inodeOf(store)) {
    clearDamageMark(store)
    return null
  }
  return mark
}

export const clearDamageMark = (store: string): void => rmSync(damageMarkPath(store), { force: true })

/** Thrown by a writable open of a store a run found damaged, so timers fail fast instead of writing into it. */
export const refuseDamagedStore = (store: string, cli?: string): void => {
  const mark = readDamageMark(store)
  if (!mark) return
  throw new CliError(
    "configuration_error",
    `the store was found damaged at ${mark.at} by \`${mark.command}\` (${mark.error}), so nothing writes to it until ` +
      `it is recovered; \`${cli ?? "<cli>"} store recover\` says what is damaged and what to do`,
    { reason: "store.damaged" },
  )
}

export const readHealthMark = (store: string): HealthMark | null => {
  try {
    return readJson<HealthMark>(healthMarkPath(store))
  } catch {
    return null
  }
}

/**
 * Records a deep check of the store. One that passed also removes the damage mark: the file reads whole. Returns the
 * mark it replaced, whose `last_ok_at` is the last known good before this check, and the damage mark it removed.
 */
export const recordDeepCheck = (
  store: string,
  health: Pick<StoreHealth, "ok" | "problems">,
  {
    cli,
    version,
    schema,
    now = Date.now,
  }: { cli: string; version?: string; schema: number | null; now?: () => number },
): { previous: HealthMark | null; cleared: DamageMark | null } => {
  const previous = readHealthMark(store)
  if (ownerStoreInTests(store)) return { previous, cleared: null }
  const checkedAt = new Date(now()).toISOString()
  const mark: HealthMark = {
    checked_at: checkedAt,
    ok: health.ok,
    problems: health.problems ?? 0,
    schema,
    cli,
    ...(version ? { cli_version: version } : {}),
    last_ok_at: health.ok ? checkedAt : (previous?.last_ok_at ?? null),
  }
  const cleared = health.ok ? readDamageMark(store) : null
  try {
    writeFileSync(healthMarkPath(store), `${JSON.stringify(mark, null, 2)}\n`, { mode: 0o600 })
  } catch {}
  if (cleared) clearDamageMark(store)
  return { previous, cleared }
}
