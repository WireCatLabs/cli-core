import { existsSync, statSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "./driver.js"
import { markJournalLost } from "./marks.js"

interface Watch {
  store: string
  command: string
  inode: number | undefined
}

const watched = new WeakMap<CacheDatabase, Watch>()

const walInode = (store: string) => statSync(`${store}-wal`, { throwIfNoEntry: false })?.ino

/** Before the open. SQLite creates `-wal` before `-shm` and deletes it after, so it never leaves `-shm` alone itself. */
export const noteShmWithoutWal = (store: string, command: string): void => {
  if (existsSync(`${store}-shm`) && !existsSync(`${store}-wal`))
    markJournalLost(store, { seen: "shm-without-wal", command })
}

export const watchJournal = (database: CacheDatabase, store: string, command: string): void => {
  watched.set(database, { store, command, inode: walInode(store) })
}

/**
 * Called before each outermost commit. A connection keeps writing into a `-wal` that was unlinked under it while the
 * next process starts a fresh one, and the two journals then overwrite each other's pages: refusing the commit is
 * the only point at which this process can still keep out of it.
 */
export const checkJournal = (database: CacheDatabase): void => {
  const watch = watched.get(database)
  if (!watch) return
  const inode = walInode(watch.store)
  if (watch.inode === undefined) {
    watch.inode = inode
    return
  }
  if (inode === watch.inode) return
  markJournalLost(watch.store, { seen: inode === undefined ? "missing" : "replaced", command: watch.command })
  throw new CliError(
    "conflict",
    "the store's journal file was deleted or replaced by another program while this command had the store open, " +
      "so nothing more is written; `store recover` says what to do",
    { reason: "store.journal-replaced" },
  )
}
