import { type Entry, validation } from "./sftp-reasons.js"

/** The store file: opening, writing and recovering it. */
export const STORE: Entry[] = [
  validation("store.refused", "the local store refused the document text"),
  ["store.not-writable", "permission_error", "the message store cannot be written from this process"],
  [
    "store.damaged",
    "configuration_error",
    "the store file is damaged; store recover says what is lost and recovers it",
  ],
  [
    "store.journal-replaced",
    "conflict",
    "another program deleted or replaced the store's journal file while it was open; store recover says what to do",
  ],
  validation("store.file-damaged", "the named store file is damaged or not a database"),
  ["store.unopenable", "configuration_error", "the store file cannot be opened at its path; details.path names it"],
  [
    "store.unreadable",
    "configuration_error",
    "the store file's header or schema is damaged, so it cannot be recovered",
  ],
  validation("store.in-use", "a process or a scheduled timer has the store open; stop it, then recover the store"),
  [
    "store.sqlite3-missing",
    "configuration_error",
    "recovering the store needs the sqlite3 program, 3.43 or newer, with its .recover command",
  ],
  validation("store.recovery-failed", "the recovered store did not pass its check, so the store was left as it was"),
  validation("store.recovering", "another recovery of the store is running; wait for it to finish"),
  validation("store.changed-during-recovery", "the store was written to during the recovery, so it was left as it was"),
  [
    "store.vector-extension-missing",
    "configuration_error",
    "the install has no sqlite-vec extension for this platform; reinstall the CLI",
  ],
  ["store.vector-extension-failed", "configuration_error", "the sqlite-vec extension did not load; reinstall the CLI"],
  validation("store.vector-invalid", "a vector to store had a non-finite value"),
]

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
