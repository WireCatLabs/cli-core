import type { Entry } from "./sftp-reasons.js"

/** A schema migration that rebuilds tables (`rebuildTables`) and refuses before it changes anything. */
export const STORE_MIGRATION: Entry[] = [
  [
    "store.unknown-columns",
    "configuration_error",
    "a migration would drop columns this store has and this build does not know; nothing was changed",
  ],
  [
    "store.rows-break-checks",
    "configuration_error",
    "the store holds rows the new schema refuses, so it was not migrated; the rows are named",
  ],
  [
    "store.rows-lost",
    "configuration_error",
    "a migration would change how many rows a table holds, so it was not run; the tables and counts are named",
  ],
  [
    "store.foreign-keys",
    "configuration_error",
    "a migration would break references between rows, so it was not run; the store is whole",
  ],
]
