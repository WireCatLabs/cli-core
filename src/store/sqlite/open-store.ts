import { mkdirSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { migrate } from "../migrations.js"
import { storeCapable } from "../open.js"
import { storePath } from "../path.js"
import { sharedConfigPath } from "../shared-config.js"
import { backfillNormalized, pendingNormalization } from "./backfill.js"
import { fillFolded } from "./folded.js"
import { logPruner } from "./log-pruning.js"
import { openSqlite, type StoreContext } from "./open.js"
import { assertReadCompatible } from "./read-compatibility.js"
import { stemsState } from "./stems.js"
import { fillStems, followDefaultStemmers } from "./stems-fill.js"

export interface StoreOptions {
  /** Open an existing compatible store without maintenance; SQLite refuses writes. */
  readOnly?: boolean
  path?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** The CLI's own name, for the advice a failed migration gives. */
  command?: string
}
export const BACKFILL_ON_OPEN = 5_000

export const openStoreContext = async ({
  path,
  env,
  now = Date.now,
  command,
  readOnly = false,
}: StoreOptions = {}): Promise<StoreContext> => {
  if (typeof readOnly !== "boolean") throw new CliError("validation_error", "readOnly must be a boolean")
  await storeCapable()
  const file = path ?? storePath(env)
  if (readOnly) {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile())
      throw new CliError("not_found", "The store does not exist as a file; read-only opening does not create it")
  } else {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    // SQLite gives its sidecar files the database's permissions.
    writeFileSync(file, "", { flag: "a", mode: 0o600 })
  }
  const opened = await openSqlite(file, { readOnly })
  const database = opened.database
  try {
    if (readOnly) assertReadCompatible(database)
    else {
      migrate(database, { now, command })
      fillFolded(database)
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
    }
    return { ...opened, now, sharedConfig: sharedConfigPath(file, env ?? process.env) }
  } catch (error) {
    database.close()
    throw error
  }
}
