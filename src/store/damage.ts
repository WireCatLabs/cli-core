import type { StoreHealth } from "./health.js"
import type { DamageMark, JournalMark } from "./marks.js"

/** One cause the evidence allows, and the one command that tells more about it. */
export interface DamageCause {
  cause: string
  check: string
}

export interface RecoveryStep {
  command: string
  why: string
  /** Replaces the store or stops a process: an app copies it for the owner to run rather than running it. */
  destructive: boolean
}

/**
 * What a damaged store means, in the owner's words: one structure the CLIs render and the desktop app can show as it
 * is. Built from what was already found, so it never reads the damaged file again.
 */
export interface StoreDamageReport {
  whatHappened: string
  likelyCauses: DamageCause[]
  impact: string[]
  externalDataSafe: string
  lastOkAt: string | null
  loss: string
  /** The first stops the writers, the last is the deep check. */
  steps: RecoveryStep[]
}

export interface DamageFindings {
  health: StoreHealth
  /** The CLI's command, which the steps name: `mail`. */
  command: string
  mark?: DamageMark | null
  journal?: JournalMark | null
  lastOkAt?: string | null
  holders?: { pid: number; name: string }[] | null
  timers?: string[] | null
  sqlite3Usable?: boolean
}

const DERIVED = new Set(["mentions", "involvements", "embeddings"])

const named = (tables: string[]) =>
  tables.length <= 5 ? tables.join(", ") : `${tables.slice(0, 5).join(", ")} and ${tables.length - 5} more`

/**
 * Tables a recovery rebuilds from the others: search indexes, the vector index, what the indexing finds, and the
 * vectors, which a search by meaning computes again for any text that has none.
 */
export const isDerivedTable = (table: string, searchIndexes: readonly string[]): boolean =>
  DERIVED.has(table) ||
  table.startsWith("vector_index_") ||
  searchIndexes.some((index) => table === index || table.startsWith(`${index}_`))

const WIRECAT_UNITS = ["memo-*", "mail-*", "tg-*", "max-*", "wirecat-*"]

const seen = (mark: DamageMark) => `\`${mark.command}\` found the store damaged at ${mark.at} (${mark.error})`

const journalSeen = (store: string, { seen, command, at }: JournalMark) => {
  const wal = `${store.replace(/^.*\//, "")}-wal`
  return seen === "shm-without-wal"
    ? `the store's journal file (${wal}) was missing when \`${command}\` opened the store at ${at}: another program deleted it, or a tool crashed while closing`
    : `the store's journal file (${wal}) was deleted or replaced by another program while \`${command}\` had the store open (${at})`
}

/** How much may be gone and since when: nothing records a row that damage takes (BUG-627). */
export const lossUnknown = (lastOkAt: string | null | undefined, gone = false): string => {
  const since = lastOkAt
    ? `since the last deep check that passed (${lastOkAt})`
    : "since the store was made (no deep check that passed is on record)"
  return (
    `${gone ? "more rows may be gone" : "how many rows were lost is unknown"}: ` +
    `damage can take rows written ${since} without leaving a trace; a sync fetches again what the servers still hold`
  )
}

const stopWriters = (timers: string[] | null | undefined): RecoveryStep => ({
  command: timers?.length
    ? `systemctl --user stop ${timers.join(" ")}`
    : `systemctl --user stop ${WIRECAT_UNITS.map((unit) => `'${unit}'`).join(" ")}`,
  why: "a tool that writes while the store is recovered damages the new file too",
  destructive: false,
})

/**
 * The report for whatever was found, or null when the store is healthy and nothing was seen. `mark`: a run saw the
 * damage; the quick check reads too little to see it, so it alone can make a store damaged. `journal`: the store's
 * journal file went away under a run, which can lose writes even when every page still reads.
 */
export const storeDamageReport = ({
  health,
  command,
  mark = null,
  journal = null,
  lastOkAt = null,
  holders = null,
  timers = null,
  sqlite3Usable = true,
}: DamageFindings): StoreDamageReport | null => {
  if (health.ok && !mark && !journal) return null
  const indexNames = (health.searchIndexes ?? []).map((index) => index.name)
  const badIndexes = (health.searchIndexes ?? []).filter((index) => !index.ok).map((index) => index.name)
  const tables = (health.damagedTables ?? []).map((one) => one.table).filter((table): table is string => table !== null)
  const sources = tables.filter((table) => !isDerivedTable(table, indexNames))
  const derived = [...new Set([...tables.filter((table) => isDerivedTable(table, indexNames)), ...badIndexes])]
  const unopened = health.error !== undefined
  const json = (health.invalidJson ?? []).map(({ table, column }) => `${table}.${column}`)
  const damaged = !health.ok || mark !== null
  const folder = health.path.replace(/\/[^/]*$/, "")

  const checked = !damaged
    ? `every page of the store reads, but ${journalSeen(health.path, journal as JournalMark)}; what was written into it may be lost`
    : health.ok
      ? `${seen(mark as DamageMark)}; the quick check reads too little to see it, and a deep check that passes clears it`
      : unopened
        ? `the store file cannot be opened: ${health.error}`
        : health.checked === "quick"
          ? "the store file's header or schema is damaged"
          : `the store file is damaged: ${health.problems ?? 0} problems` +
            (sources.length ? ` in the data of ${named(sources)}` : "") +
            (derived.length ? `${sources.length ? ", and" : " in"} the search data of ${named(derived)}` : "") +
            (json.length ? `; values that are not valid JSON in ${named(json)}` : "")
  const whatHappened = mark && !health.ok ? `${checked}; ${seen(mark)}` : checked

  const impact = [
    ...(sources.length
      ? [`some rows of ${named(sources)} cannot be read; a recovery keeps every row it can read and names the rest`]
      : []),
    ...(derived.length
      ? [`searches may miss results or fail; ${named(derived)} hold nothing that is not elsewhere, and are rebuilt`]
      : []),
    ...(json.length
      ? [`a read of a row with a broken JSON value fails ("malformed JSON"); a recovery clears those values`]
      : []),
    ...(!damaged
      ? ["everything works; rows written while the journal was gone may be missing, and a sync fetches them again"]
      : mark
        ? [
            "reads that do not touch a damaged page work; every command that writes the store refuses until it is recovered",
          ]
        : ["reads that do not touch a damaged page work; a write that touches one fails until the store is recovered"]),
  ]

  const likelyCauses: DamageCause[] = [
    ...(journal
      ? [{ cause: journalSeen(health.path, journal), check: `ls -li --time-style=full-iso ${folder}/` }]
      : []),
    ...(holders?.length
      ? [
          {
            cause: `two programs wrote the file without seeing each other: ${holders.map(({ name, pid }) => `${name} (process ${pid})`).join(", ")} still ${holders.length === 1 ? "has" : "have"} it open`,
            check: `fuser -v ${health.path}`,
          },
        ]
      : []),
    ...(damaged
      ? [
          {
            cause: "the computer lost power or crashed while a tool was writing",
            check: `journalctl --user ${WIRECAT_UNITS.map((unit) => `-u '${unit}'`).join(" ")} --since -14d | grep -i -e malformed -e corrupt -e 'disk full'`,
          },
          { cause: "the disk filled up while a tool was writing", check: `df -h ${folder}` },
          {
            cause:
              "the file was copied, restored or synced while a tool had it open, or it sits in a synced or network folder",
            check: `findmnt -T ${folder}`,
          },
          {
            cause: "a fault of the disk itself",
            check: "journalctl -k --since -14d | grep -i -e 'I/O error' -e nvme -e ata",
          },
        ]
      : []),
  ]

  const steps: RecoveryStep[] = [
    stopWriters(timers),
    ...(holders ?? []).map(({ pid, name }) => ({
      command: `kill ${pid}`,
      why: `${name} (process ${pid}) has the store open`,
      destructive: true,
    })),
    ...(damaged && !sqlite3Usable
      ? [
          {
            command: "sudo apt install sqlite3",
            why: "the recovery copies rows with the sqlite3 program, 3.43 or newer (on macOS: brew install sqlite)",
            destructive: false,
          },
        ]
      : []),
    ...(damaged
      ? [
          {
            command: `${command} store recover run`,
            why:
              "copies every readable row into a new file and puts it in place of the store; the damaged file is " +
              "kept beside it, and it prints the syncs that fetch again what was lost",
            destructive: true,
          },
        ]
      : []),
    {
      command: `${command} store recover`,
      why: "checks every page again; a check that passes lifts the damage mark",
      destructive: false,
    },
  ]

  return {
    whatHappened,
    likelyCauses,
    impact,
    externalDataSafe:
      "only this computer's copy is damaged: Telegram, MAX, WhatsApp, the mail servers and Google Drive keep their " +
      "own data, so whatever is lost here can be fetched again by a sync",
    lastOkAt,
    loss: lossUnknown(lastOkAt),
    steps,
  }
}
