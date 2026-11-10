import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { DEFAULT_DECISION_POLICY, type DecisionPolicy } from "../decisions.js"
import { noteShmWithoutWal, watchJournal } from "../journal.js"
import { refuseDamagedStore } from "../marks.js"
import { migrate } from "../migrations.js"
import { storeCapable } from "../open.js"
import { refuseOwnerStoreInTests, storePath } from "../path.js"
import { sharedConfigPath } from "../shared-config.js"
import { backfillNormalized, pendingNormalization } from "./backfill.js"
import { maskStoredBotTokens } from "./bot-tokens.js"
import { fillFiles } from "./files.js"
import { fillFolded } from "./folded.js"
import { fillJoinKeys } from "./join-keys.js"
import { logPruner } from "./log-pruning.js"
import { type OpenedSqlite, openSqlite, type StoreContext } from "./open.js"
import { movePaymentFacts } from "./payment-facts.js"
import { loadProviders } from "./providers.js"
import { assertReadCompatible, readCompatibility } from "./read-compatibility.js"
import { pruneRollbackCopies } from "./rollback-copy.js"
import { stemsState } from "./stems.js"
import { fillStems, followDefaultStemmers } from "./stems-fill.js"
import { moveSuggestedLinks } from "./suggested-links.js"
import { fillFoundTaskTitles } from "./task-titles.js"
import { purgeTestAccounts } from "./test-accounts.js"
import { fillVectorIndexes } from "./vector-index.js"

export interface StoreOptions {
  /** Open an existing compatible store without maintenance, migrating an older one first; SQLite refuses writes. */
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
  /** The host's decision policy (its `agent_decisions`); off unless the host passes `agentDecisions: true`. */
  decisions?: DecisionPolicy
}
export const BACKFILL_ON_OPEN = 5_000

const NOT_WRITABLE = new Set(["EACCES", "EPERM", "EROFS"])

const createWritable = (file: string): void => {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    // Only a missing file: on Linux, closing any descriptor of a file drops every POSIX lock this process holds on it,
    // so opening the store a second time would take SQLite's locks from the connection already open (BUG-557).
    // SQLite gives its sidecar files the database's permissions.
    if (existsSync(file)) accessSync(file, constants.W_OK)
    else writeFileSync(file, "", { flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return
    if (!NOT_WRITABLE.has((error as NodeJS.ErrnoException).code ?? "")) throw error
    // The errno's own sentence names the path, which holds the owner's home folder.
    throw new CliError(
      "permission_error",
      "the message store cannot be written from here; run where it is writable, or set MESSAGING_STORE",
      { reason: "store.not-writable" },
    )
  }
}

// A new tool's first command may only read; it migrates the file as its first write would.
const openReadable = async (file: string, options: StoreOptions): Promise<OpenedSqlite> => {
  const first = await openSqlite(file, { readOnly: true })
  try {
    if (readCompatibility(first.database, options.command) === "current") return first
  } catch (error) {
    first.database.close()
    throw error
  }
  first.database.close()
  const writable = await openStoreContext({ ...options, path: file, readOnly: false })
  writable.database.close()
  const migrated = await openSqlite(file, { readOnly: true })
  try {
    assertReadCompatible(migrated.database, options.command)
    return migrated
  } catch (error) {
    migrated.database.close()
    throw error
  }
}

export const openStoreContext = async (options: StoreOptions = {}): Promise<StoreContext> => {
  const {
    path,
    env,
    now = Date.now,
    command,
    version,
    warn = (line) => process.stderr.write(`${line}\n`),
    readOnly = false,
    decisions = DEFAULT_DECISION_POLICY,
  } = options
  if (typeof readOnly !== "boolean") throw new CliError("validation_error", "readOnly must be a boolean")
  await storeCapable()
  const file = path ?? storePath(env)
  refuseOwnerStoreInTests(file)
  if (readOnly) {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile())
      throw new CliError("not_found", "The store does not exist as a file; read-only opening does not create it")
  } else {
    createWritable(file)
    refuseDamagedStore(file, command)
    noteShmWithoutWal(file, command ?? "unknown")
  }
  const opened = readOnly ? await openReadable(file, options) : await openSqlite(file, { readOnly })
  const database = opened.database
  try {
    if (!readOnly) {
      watchJournal(database, file, command ?? "unknown")
      const notice = migrate(database, {
        now,
        command,
        ...(version ? { version } : {}),
        rollback: { store: file, warn },
      })
      if (notice) warn(notice)
      pruneRollbackCopies(database, now())
      fillFiles(database, now)
      fillFolded(database)
      fillJoinKeys(database)
      moveSuggestedLinks(database, now)
      movePaymentFacts({ ...opened, now, decisions })
      purgeTestAccounts({ ...opened, now, decisions }, warn)
      maskStoredBotTokens({ ...opened, now, decisions })
      fillFoundTaskTitles(database, warn)
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
    return {
      ...opened,
      now,
      sharedConfig: sharedConfigPath(file, env ?? process.env),
      decisions,
    }
  } catch (error) {
    database.close()
    throw error
  }
}
