import type { StoreHealth } from "./health.js"

/**
 * What a damaged store means, in the owner's words: one structure the CLIs render and the desktop app can show as it
 * is. Built from a health check only, so it never reads the damaged file again.
 */
export interface DamageExplanation {
  what: string
  causes: string[]
  investigate: string[]
  impact: string[]
  externalUnaffected: string
  steps: string[]
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

export const explainDamage = (health: StoreHealth, command: string): DamageExplanation | null => {
  if (health.ok) return null
  const indexNames = (health.searchIndexes ?? []).map((index) => index.name)
  const badIndexes = (health.searchIndexes ?? []).filter((index) => !index.ok).map((index) => index.name)
  const tables = (health.damagedTables ?? []).map((one) => one.table).filter((table): table is string => table !== null)
  const sources = tables.filter((table) => !isDerivedTable(table, indexNames))
  const derived = [...new Set([...tables.filter((table) => isDerivedTable(table, indexNames)), ...badIndexes])]
  const unopened = health.error !== undefined

  const what = unopened
    ? `the store file cannot be opened: ${health.error}`
    : health.checked === "quick"
      ? "the store file's header or schema is damaged"
      : `the store file is damaged: ${health.problems ?? 0} problems` +
        (sources.length ? ` in the data of ${named(sources)}` : "") +
        (derived.length ? `${sources.length ? ", and" : " in"} the search data of ${named(derived)}` : "")

  const impact = [
    ...(sources.length
      ? [`some rows of ${named(sources)} cannot be read; a recovery keeps every row it can read and names the rest`]
      : []),
    ...(derived.length
      ? [`searches may miss results or fail; ${named(derived)} hold nothing that is not elsewhere, and are rebuilt`]
      : []),
    "reads that do not touch a damaged page work; a write that touches one fails until the store is recovered",
  ]

  return {
    what,
    causes: [
      "the computer lost power or crashed, or the disk filled up, while a tool was writing",
      "the file was copied, restored or synced while a tool had it open, or it sits in a synced or network folder",
      "a fault of the disk itself",
    ],
    investigate: [
      `journalctl --user ${WIRECAT_UNITS.map((unit) => `-u '${unit}'`).join(" ")} --since -14d | grep -i -e malformed -e corrupt -e 'disk full'`,
      "journalctl -k --since -14d | grep -i -e 'I/O error' -e nvme -e ata",
      `df -h ${health.path.replace(/\/[^/]*$/, "")}`,
      ...(health.checked === "quick" ? [`${command} store recover`] : []),
    ],
    impact,
    externalUnaffected:
      "only this computer's copy is damaged: Telegram, MAX, the mail servers and Google Drive keep their own data, " +
      "so whatever is lost here can be fetched again by a sync",
    steps: [
      "stop every timer and server of the WireCat tools; `store recover run` lists the ones still running",
      `${command} store recover run`,
      "run the fetch commands it prints, then start the timers again",
    ],
  }
}
