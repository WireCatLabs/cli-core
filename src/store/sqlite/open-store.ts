import { mkdirSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { migrate } from "../migrations.js"
import { storeCapable } from "../open.js"
import { storePath } from "../path.js"
import { sharedConfigPath } from "../shared-config.js"
import { backfillNormalized, pendingNormalization } from "./backfill.js"
import { fillFiles } from "./files.js"
import { fillFolded } from "./folded.js"
import { fillJoinKeys } from "./join-keys.js"
import { logPruner } from "./log-pruning.js"
import { openSqlite, type StoreContext } from "./open.js"
import { loadProviders } from "./providers.js"
import { assertReadCompatible } from "./read-compatibility.js"
import { stemsState } from "./stems.js"
import { fillStems, followDefaultStemmers } from "./stems-fill.js"
import { fillVectorIndexes } from "./vector-index.js"

export interface StoreOptions {
  /** Open an existing compatible store without maintenance; SQLite refuses writes. */
  readOnly?: boolean
  path?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** The CLI's own name, for the advice a failed migration gives. */
  command?: string
  /** The CLI's own version: with `command`, recorded in the store so an upgrade can name the CLIs it locks out. */
  version?: string
  /** Where the notice of an upgrade that locks other CLIs out goes; stderr, since stdout may carry JSON or MCP. */
  warn?: (line: string) => void
}
export const BACKFILL_ON_OPEN = 5_000

const NOT_WRITABLE = new Set(["EACCES", "EPERM", "EROFS"])

const createWritable = (file: string): void => {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    // SQLite gives its sidecar files the database's permissions.
    writeFileSync(file, "", { flag: "a", mode: 0o600 })
  } catch (error) {
    if (!NOT_WRITABLE.has((error as NodeJS.ErrnoException).code ?? "")) throw error
    // The errno's own sentence names the path, which holds the owner's home folder.
    throw new CliError(
      "permission_error",
      "the message store cannot be written from here; run where it is writable, or set MESSAGING_STORE",
      { reason: "store.not-writable" },
    )
  }
}

export const openStoreContext = async ({
  path,
  env,
  now = Date.now,
  command,
  version,
  warn = (line) => process.stderr.write(`${line}\n`),
  readOnly = false,
}: StoreOptions = {}): Promise<StoreContext> => {
  if (typeof readOnly !== "boolean") throw new CliError("validation_error", "readOnly must be a boolean")
  await storeCapable()
  const file = path ?? storePath(env)
  if (readOnly) {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile())
      throw new CliError("not_found", "The store does not exist as a file; read-only opening does not create it")
  } else createWritable(file)
  const opened = await openSqlite(file, { readOnly })
  const database = opened.database
  try {
    if (readOnly) assertReadCompatible(database, command)
    else {
      const notice = migrate(database, { now, command, ...(version ? { version } : {}) })
      if (notice) warn(notice)
      fillFiles(database, now)
      fillFolded(database)
      fillJoinKeys(database)
      const pending = pendingNormalization(database)
      if (pending > 0 && pending <= BACKFILL_ON_OPEN) backfillNormalized(database)
      followDefaultStemmers(database, now)
      const stemming = stemsState(database)
      if (
        stemming?.cause === "building" &&
        stemming.watermark - stemming.filledThrough + stemming.pending <= BACKFILL_ON_OPEN
      )
        fillStems(database, { now })
      logPruner(database, now)()
      fillVectorIndexes(database, {
        notice: (model) =>
          warn(`indexing the stored vectors of ${model} for search by meaning — once; a large archive takes minutes`),
      })
    }
    loadProviders(database)
    return { ...opened, now, sharedConfig: sharedConfigPath(file, env ?? process.env) }
  } catch (error) {
    database.close()
    throw error
  }
}
