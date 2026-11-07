import { execFileSync, spawn } from "node:child_process"
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import { Transform } from "node:stream"
import { CliError } from "@wirecat/cli-base"
import { holdersOf } from "../background/processes.js"
import { isStoreDamage } from "../errors/failures.js"
import type { CacheDatabase } from "./driver.js"
import { fts5Tables, type InvalidJson, invalidJson, type StoreHealth, storeHealth } from "./health.js"
import { migrate } from "./migrations.js"
import { resetAttachmentWords } from "./sqlite/attachment-texts.js"
import { involvementStoreOver } from "./sqlite/involvements.js"
import { drainMeetingIndex } from "./sqlite/meetings.js"
import { rebuildMentions } from "./sqlite/mentions.js"
import { CORPORA, drainCorpus, fillTrigrams, resetNoteIndex } from "./sqlite/note-index.js"
import { openSqlite } from "./sqlite/open.js"
import { fillSearchIndex, resetSearchIndex } from "./sqlite/search-index.js"
import { stemmerCache } from "./sqlite/stems.js"
import { fillStems, resetStems } from "./sqlite/stems-fill.js"
import { fillVectorIndexes } from "./sqlite/vector-index.js"

/** `contentless_delete`, which every word index uses, came in SQLite 3.43. */
export const SQLITE3_MINIMUM = [3, 43, 0] as const

const STORE_PARTS = ["", "-wal", "-shm"]
const RECOVER_LOCK = ".recover-lock"
/** The start of a row `.recover` writes; a value's own lines cannot start a line with it, its quotes are doubled. */
const INSERTED = /^INSERT OR IGNORE INTO '([^']+)'/
const LOST_AND_FOUND = "recover_lost_and_found"

/** The `sqlite3` program's version, or why it cannot be used: the recovery reads the damaged file with it. */
/** Some builds leave out the page table `.recover` reads, and fail only when it runs. */
const recovers = (program: string): boolean => {
  try {
    execFileSync(program, [":memory:", ".recover"], { stdio: ["ignore", "ignore", "pipe"] })
    return true
  } catch {
    return false
  }
}

export const sqlite3Program = (program = "sqlite3"): { program: string; version: string | null; usable: boolean } => {
  let version: string | null = null
  try {
    version =
      execFileSync(program, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(" ")[0] ??
      null
  } catch {
    return { program, version: null, usable: false }
  }
  const parts = (version ?? "").split(".").map(Number)
  const at = SQLITE3_MINIMUM.findIndex((wanted, i) => (parts[i] ?? 0) !== wanted)
  const recent = at === -1 || (parts[at] ?? 0) > (SQLITE3_MINIMUM[at] ?? 0)
  return { program, version, usable: recent && recovers(program) }
}

/** The WireCat timers still scheduled: each may open the store while it is being recovered. Linux only. */
export const activeTimers = (): string[] | undefined => {
  if (process.platform !== "linux") return undefined
  try {
    return execFileSync("systemctl", ["--user", "list-timers", "--plain", "--no-legend"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => line.trim().split(/\s+/).at(-2) ?? "")
      .filter((unit) => /^(memo|mail|tg|max|whatsapp|zoom|drive|gcal|wirecat)-.*\.timer$/.test(unit))
  } catch {
    return undefined
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The process recovering the store now, from the lock file it keeps beside it; a lock whose process ended is none. */
export const runningRecovery = (path: string): number | null => {
  let pid: number
  try {
    pid = Number(readFileSync(`${path}${RECOVER_LOCK}`, "utf8").trim())
  } catch {
    return null
  }
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null
}

/** Between its copy and its swap a recovery holds none of the store's files, so only its lock shows it. */
const takeRecoverLock = (path: string): (() => void) => {
  const lock = `${path}${RECOVER_LOCK}`
  const take = () => writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 })
  try {
    take()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const pid = runningRecovery(path)
    if (pid === null) {
      rmSync(lock, { force: true })
      take()
    } else {
      throw new CliError("validation_error", `the store is being recovered by process ${pid} — wait for it to finish`, {
        reason: "store.recovering",
      })
    }
  }
  return () => rmSync(lock, { force: true })
}

/**
 * Processes that have any of the store's files open, by PID and program name, never their arguments, and the one
 * recovering it.
 */
export const storeHolders = (path: string): { pid: number; name: string }[] | undefined => {
  const folder = realpathSync(dirname(path))
  const files = STORE_PARTS.map((suffix) => join(folder, `${basename(path)}${suffix}`))
  // A process that kept writing after its log was deleted holds it as "<path> (deleted)" (BUG-557).
  const wanted =
    process.platform === "linux" ? files.flatMap((file) => [file, `${file} (deleted)`]) : files.filter(existsSync)
  const recovering = runningRecovery(path)
  const pids = holdersOf(wanted)
  if (pids === undefined && recovering === null) return undefined
  const all = [
    ...new Set([...(pids ?? []), ...(recovering !== null && recovering !== process.pid ? [recovering] : [])]),
  ]
  return all.map((pid) => {
    let name = "?"
    try {
      name = readFileSync(`/proc/${pid}/comm`, "utf8").trim()
    } catch {}
    return { pid, name }
  })
}

/** Rows per table that holds data; `null` where the table cannot be counted. Search shadow tables are left out. */
export const tableRows = (database: CacheDatabase): Record<string, number | null> => {
  const indexes = fts5Tables(database).map((index) => index.name)
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND rootpage > 0 AND name NOT LIKE 'sqlite_%' " +
        "AND name NOT LIKE 'vector_index_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name))
    .filter((name) => !indexes.some((index) => name.startsWith(`${index}_`)))
  return Object.fromEntries(
    tables.map((table) => {
      try {
        return [table, Number(database.prepare(`SELECT count(*) AS n FROM "${table}"`).get()?.n)]
      } catch {
        return [table, null]
      }
    }),
  )
}

/**
 * Copies every row SQLite can still read into a new file with the `sqlite3` program's `.recover`: node:sqlite has
 * no recovery API. The damaged file is opened read-only. Rows that fit no table go to a table the rebuild counts
 * and drops; a row that breaks its table's constraints (a NULL where none may be) is skipped. Free pages are not
 * read: what they hold was deleted, and must not come back.
 */
export const copyReadableRows = (
  path: string,
  target: string,
  program = "sqlite3",
): Promise<{ errors: string[]; read: Record<string, number> }> =>
  new Promise((resolve, reject) => {
    const reader = spawn(
      program,
      ["-readonly", path, `.recover --ignore-freelist --lost-and-found ${LOST_AND_FOUND}`],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    // `.recover` writes a virtual table's row into the schema itself, which the shell refuses while defensive.
    const writer = spawn(program, ["-cmd", ".dbconfig defensive off", target], { stdio: ["pipe", "ignore", "pipe"] })
    const errors: string[] = []
    const collect = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n"))
        if (line && errors.length < 50) errors.push(line.slice(0, 300))
    }
    reader.stderr.on("data", collect)
    writer.stderr.on("data", collect)
    const read: Record<string, number> = {}
    let rest = ""
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        const lines = (rest + chunk.toString("latin1")).split("\n")
        rest = lines.pop() ?? ""
        for (const line of lines) {
          const table = INSERTED.exec(line)?.[1]
          if (table) read[table] = (read[table] ?? 0) + 1
        }
        done(null, chunk)
      },
    })
    reader.stdout.pipe(counter).pipe(writer.stdin)
    let exits = 0
    let readerCode: number | null = null
    const exited = () => {
      exits += 1
      if (exits < 2) return
      if (readerCode !== 0)
        reject(new CliError("validation_error", `sqlite3 could not read the store: ${errors.join("; ")}`))
      else resolve({ errors, read })
    }
    reader.on("error", reject)
    writer.on("error", reject)
    reader.on("close", (code) => {
      readerCode = code
      exited()
    })
    writer.on("close", exited)
  })

export interface DerivedRebuild {
  lostAndFound: number
  searchIndexes: string[]
  /** Indexes recreated empty that this build has no recipe for: they fill as the tools that own them write. */
  unfilled: string[]
  mentions: number
  vectorModels: string[]
  /** Per model: pieces of text a search by meaning computes a vector for when it first needs one. */
  chunksWithoutVector: Record<string, number>
}

/** Each index recreated empty, and how it is filled again from the data: the same code the tools index with. */
const FILLERS: Record<string, (database: CacheDatabase, now: () => number) => void> = {
  message_words: (database, now) => {
    resetSearchIndex(database)
    fillSearchIndex(database, { now })
  },
  message_stems: (database, now) => {
    resetStems(database, { force: true, now })
    fillStems(database, { now })
  },
  attachment_words: (database) => void resetAttachmentWords(database),
  attachment_name_words: (database) =>
    // As migration 20 filled it: й and ё fold as the triggers fold them.
    database.exec(
      "INSERT INTO attachment_name_words (rowid, name) SELECT id, " +
        "replace(replace(replace(replace(name, 'й', 'и'), 'Й', 'И'), 'ё', 'е'), 'Ё', 'Е') FROM attachments WHERE name IS NOT NULL",
    ),
  meeting_words: (database) => {
    database.exec(
      "INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) " +
        "SELECT 'meeting_transcript_row', id FROM meeting_transcript_rows " +
        "UNION ALL SELECT 'meeting_chat_message', id FROM meeting_chat_messages " +
        "UNION ALL SELECT 'meeting_summary', id FROM meeting_summaries",
    )
    drainMeetingIndex(database)
  },
  // Built per account by the first search that needs them.
  meeting_stems: (database) =>
    database.exec(
      "UPDATE search_index_state SET filled_through = 0, built_at = NULL WHERE name LIKE 'meeting_stems:%'",
    ),
}

const CORPUS_TABLES = new Set(
  Object.values(CORPORA).flatMap((corpus) => [`${corpus.type}_words`, `${corpus.type}_stems`]),
)
const TRIGRAMS = ["note_trigrams", "document_trigrams"]

/**
 * Drops every search index and vector index and makes it again empty, then fills it from the data. A recovered
 * index holds whatever pages survived, which no check can tell from a whole one; the data they come from can.
 */
export const rebuildDerived = (
  database: CacheDatabase,
  { now = Date.now, note = () => {} }: { now?: () => number; note?: (text: string) => void } = {},
): DerivedRebuild => {
  const lost = database.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(LOST_AND_FOUND)
  const lostAndFound = lost ? Number(database.prepare(`SELECT count(*) AS n FROM ${LOST_AND_FOUND}`).get()?.n) : 0
  if (lost) database.exec(`DROP TABLE ${LOST_AND_FOUND}`)

  const indexes = fts5Tables(database)
  for (const { name, sql } of indexes) {
    database.exec(`DROP TABLE "${name}"`)
    database.exec(sql)
  }
  const vectors = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'vector_index_[0-9]*' AND sql LIKE 'CREATE VIRTUAL%'",
    )
    .all()
    .map((row) => String(row.name))
  for (const table of vectors) {
    database.exec(`DROP TRIGGER IF EXISTS "${table}_redo"`)
    database.exec(`DROP TABLE "${table}"`)
    database.prepare("DELETE FROM vector_indexes WHERE id = ?").run(Number(table.replace("vector_index_", "")))
  }

  const unfilled: string[] = []
  const stemmerFor = stemmerCache()
  for (const { name, external } of indexes) {
    note(`rebuilding ${name}`)
    if (external) database.exec(`INSERT INTO "${name}" ("${name}") VALUES ('rebuild')`)
    else if (FILLERS[name]) FILLERS[name](database, now)
    else if (!CORPUS_TABLES.has(name) && !TRIGRAMS.includes(name)) unfilled.push(name)
  }
  note("rebuilding the words of notes, documents, memories, mail, tasks, transcripts and events")
  resetNoteIndex(database)
  for (const corpus of Object.values(CORPORA)) drainCorpus(database, corpus, stemmerFor)
  for (const name of TRIGRAMS) {
    const type = name.replace("_trigrams", "")
    database
      .prepare(
        `UPDATE search_index_state SET filled_through = 0, watermark = (SELECT coalesce(max(id), 0) FROM ${type}s) WHERE name = ?`,
      )
      .run(name)
  }
  fillTrigrams(database)

  note("finding mentions again")
  const mentions = rebuildMentions(database, { now: now() }).mentions
  involvementStoreOver({ database, now }).rebuild()
  note("indexing the stored vectors")
  const vectorModels = fillVectorIndexes(database)
  // Per model, so each lookup is one probe of the embeddings' primary key.
  const without = database.prepare(
    "SELECT count(*) AS n FROM chunks k WHERE NOT EXISTS (SELECT 1 FROM embeddings v WHERE v.model = ? AND v.content_hash = k.content_hash)",
  )
  const chunksWithoutVector = Object.fromEntries(
    database
      .prepare("SELECT model FROM vector_indexes ORDER BY model")
      .all()
      .map((row) => [String(row.model), Number(without.get(String(row.model))?.n)]),
  )
  return {
    lostAndFound,
    searchIndexes: indexes.map((index) => index.name),
    unfilled,
    mentions,
    vectorModels,
    chunksWithoutVector,
  }
}

export interface DanglingRows {
  table: string
  parent: string
  rows: number
  /** Up to 20 keys of the parent rows they point at, which the store no longer holds. */
  missing: (number | string)[]
}

/** Rows that point at a row the store does not hold: after a recovery, mostly rows that could not be read. */
export const danglingRows = (database: CacheDatabase): DanglingRows[] =>
  database
    .prepare(
      `SELECT "table" AS child, parent, fkid, count(*) AS n FROM pragma_foreign_key_check GROUP BY 1, 2, 3 ORDER BY 4 DESC`,
    )
    .all()
    .map((group) => {
      const child = String(group.child)
      const column = database
        .prepare(`SELECT "from" AS name FROM pragma_foreign_key_list(?) WHERE id = ? ORDER BY seq LIMIT 1`)
        .get(child, Number(group.fkid))?.name
      let missing: (number | string)[] = []
      try {
        missing = database
          .prepare(
            `SELECT DISTINCT "${String(column)}" AS id FROM "${child}" WHERE rowid IN ` +
              `(SELECT rowid FROM pragma_foreign_key_check(?) WHERE fkid = ?) ORDER BY 1 LIMIT 20`,
          )
          .all(child, Number(group.fkid))
          .map((row) => (typeof row.id === "number" ? row.id : String(row.id)))
      } catch {}
      return { table: child, parent: String(group.parent), rows: Number(group.n), missing }
    })

/** Mail accounts whose emails other rows still point at: the ones a mail sync should list again. */
const mailToFetch = (database: CacheDatabase): { account: string; emails: number }[] => {
  try {
    return database
      .prepare(
        `SELECT a.external_id AS account, count(DISTINCT l.email_id) AS n FROM email_locations l
           JOIN mailboxes b ON b.id = l.mailbox_id JOIN accounts a ON a.id = b.account_id
         WHERE NOT EXISTS (SELECT 1 FROM emails e WHERE e.id = l.email_id) GROUP BY a.id ORDER BY a.external_id`,
      )
      .all()
      .map((row) => ({ account: String(row.account), emails: Number(row.n) }))
  } catch {
    return []
  }
}

/**
 * Sets each value the tools read as JSON that SQLite's JSON functions refuse to NULL, or drops its row where the
 * column may not be NULL: `.recover` copies a damaged value that still reads, and a JSON read of it fails.
 */
export const clearInvalidJson = (database: CacheDatabase): InvalidJson[] => {
  const found = invalidJson(database)
  for (const { table, column, required } of found) {
    const invalid = `"${column}" IS NOT NULL AND NOT json_valid("${column}")`
    database.exec(
      required
        ? `DELETE FROM "${table}" WHERE ${invalid}`
        : `UPDATE "${table}" SET "${column}" = NULL WHERE ${invalid}`,
    )
  }
  return found
}

export interface LostRows {
  table: string
  before: number | null
  read: number
  kept: number
}

export interface Recovery {
  path: string
  keptAt: string
  sqlite3: string
  /**
   * Tables that lost rows or may have: `before` is null where the damaged file could not count them, `read` is what
   * `.recover` found, `kept` what fit the table; rows on pages it could not read at all are in none of them.
   */
  lost: LostRows[]
  dangling: DanglingRows[]
  /** Values that were not valid JSON: set to NULL, or the row dropped where `required`. */
  invalidJson: InvalidJson[]
  mailToFetch: { account: string; emails: number }[]
  rebuilt: DerivedRebuild
  copyErrors: string[]
  health: StoreHealth
  seconds: { copy: number; rebuild: number; check: number; total: number }
}

export interface RecoverOptions {
  path: string
  command: string
  version?: string
  sqlite3?: string
  now?: () => number
  note?: (text: string) => void
  /** Copies the readable rows into the new file; `copyReadableRows` unless a test gives its own. */
  copy?: (path: string, target: string) => Promise<{ errors: string[]; read: Record<string, number> }>
}

const refuseInUse = (path: string) => {
  const holders = storeHolders(path)
  if (holders && holders.length > 0) {
    const timers = activeTimers() ?? []
    throw new CliError(
      "validation_error",
      `the store is open in ${holders.map(({ pid, name }) => `${name} (process ${pid})`).join(", ")} — stop it first` +
        (timers.length ? `, and the timers: systemctl --user stop ${timers.join(" ")}` : ""),
      { reason: "store.in-use" },
    )
  }
}

/**
 * Copies every readable row of a damaged store into a new file, rebuilds what is derived from them, checks the
 * result, and puts it in place of the store. The damaged file is kept beside it and never written to.
 */
export const recoverStore = async ({
  path,
  command,
  version,
  sqlite3 = "sqlite3",
  now = Date.now,
  note = () => {},
  copy,
}: RecoverOptions): Promise<Recovery> => {
  const started = Date.now()
  if (!existsSync(path)) throw new CliError("not_found", `no store at ${path}`)
  const program = copy ? { program: sqlite3, version: "given", usable: true } : sqlite3Program(sqlite3)
  if (!program.usable) {
    throw new CliError(
      "configuration_error",
      program.version
        ? `sqlite3 ${program.version} cannot recover: the recovery needs ${SQLITE3_MINIMUM.join(".")} or newer, built with .recover`
        : "the recovery needs the sqlite3 program with its .recover command: install it (apt install sqlite3, brew install sqlite)",
      { reason: "store.sqlite3-missing" },
    )
  }
  const releaseLock = takeRecoverLock(path)
  try {
    refuseInUse(path)
    const bytes = STORE_PARTS.reduce(
      (sum, suffix) => sum + (statSync(`${path}${suffix}`, { throwIfNoEntry: false })?.size ?? 0),
      0,
    )
    const { bavail, bsize } = statfsSync(dirname(path))
    if (Number(bavail) * Number(bsize) < bytes * 1.2)
      throw new CliError(
        "validation_error",
        `the recovery needs about ${Math.ceil((bytes * 1.2) / 1e9)} GB free beside the store`,
      )
    return await recoverLocked({ path, command, version, sqlite3, now, note, copy, started, program })
  } finally {
    releaseLock()
  }
}

const recoverLocked = async ({
  path,
  command,
  version,
  sqlite3,
  now,
  note,
  copy,
  started,
  program,
}: Required<Pick<RecoverOptions, "path" | "command" | "sqlite3" | "now" | "note">> &
  Pick<RecoverOptions, "version" | "copy"> & {
    started: number
    program: { version: string | null }
  }): Promise<Recovery> => {
  // Kept open to the swap: data_version moves only when another connection commits, never for a reader's
  // checkpoint or a log reset, which change the files' times and sizes but not one row.
  const watch = (await openSqlite(path, { readOnly: true })).database
  let watching = true
  const stopWatching = () => {
    if (watching) watch.close()
    watching = false
  }
  try {
    const dataVersion = () => Number(watch.prepare("PRAGMA data_version").get()?.data_version)
    let rowsBefore: Record<string, number | null>
    try {
      rowsBefore = tableRows(watch)
    } catch (error) {
      if (!isStoreDamage(error)) throw error
      throw new CliError(
        "configuration_error",
        "the store file's header or schema is damaged, so its tables cannot be listed and it cannot be recovered; " +
          "the file was left as it was",
        { reason: "store.unreadable" },
      )
    }
    const before = { data: dataVersion(), inode: statSync(path).ino }

    const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-")
    const target = `${path}.recovering-${stamp}`
    writeFileSync(target, "", { flag: "wx", mode: 0o600 })
    const dropTarget = () => {
      for (const suffix of [...STORE_PARTS, "-journal"]) rmSync(`${target}${suffix}`, { force: true })
    }
    note(`copying the readable rows into ${target}`)
    let copied: number
    let copyErrors: string[]
    let read: Record<string, number>
    let opened: Awaited<ReturnType<typeof openSqlite>>
    try {
      ;({ errors: copyErrors, read } = await (copy ?? ((from, to) => copyReadableRows(from, to, sqlite3)))(
        path,
        target,
      ))
      copied = Date.now()
      opened = await openSqlite(target)
    } catch (error) {
      dropTarget()
      throw error
    }
    let rebuilt: DerivedRebuild
    let kept: Record<string, number | null>
    let dangling: DanglingRows[]
    let json: InvalidJson[]
    let fetch: { account: string; emails: number }[]
    try {
      kept = tableRows(opened.database)
      migrate(opened.database, { command, ...(version ? { version } : {}) })
      note("clearing values that are not valid JSON")
      json = clearInvalidJson(opened.database)
      rebuilt = rebuildDerived(opened.database, { now, note })
      note("looking for rows that point at rows that were lost")
      dangling = danglingRows(opened.database)
      fetch = mailToFetch(opened.database)
      opened.database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    } catch (error) {
      opened.database.close()
      dropTarget()
      throw error
    }
    opened.database.close()
    const rebuiltAt = Date.now()

    note("checking the recovered file")
    const health = await storeHealth(target, { deep: true })
    const checkedAt = Date.now()
    if (!health.ok) {
      throw new CliError(
        "validation_error",
        `the recovered file did not pass its check, so the store was left as it was; the file is kept at ${target}`,
        { reason: "store.recovery-failed" },
      )
    }

    refuseInUse(path)
    const changed = dataVersion() !== before.data || statSync(path, { throwIfNoEntry: false })?.ino !== before.inode
    stopWatching()
    if (changed) {
      throw new CliError(
        "validation_error",
        `the store was written to during the recovery, so it was left as it was — stop every timer and run it again; ${target} can be deleted`,
        { reason: "store.changed-during-recovery" },
      )
    }
    const keptAt = `${path}.before-recover-${stamp}`
    for (const suffix of STORE_PARTS)
      if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${keptAt}${suffix}`)
    for (const suffix of STORE_PARTS)
      if (existsSync(`${target}${suffix}`)) renameSync(`${target}${suffix}`, `${path}${suffix}`)

    const lost = Object.entries(rowsBefore)
      .map(([table, before]) => ({ table, before, read: read[table] ?? 0, kept: kept[table] ?? 0 }))
      .filter(({ before, read, kept }) => before === null || before > kept || read > kept)
    const seconds = (from: number, to: number) => Math.round((to - from) / 100) / 10
    return {
      path,
      keptAt,
      sqlite3: program.version as string,
      lost,
      dangling,
      invalidJson: json,
      mailToFetch: fetch,
      rebuilt,
      copyErrors,
      health,
      seconds: {
        copy: seconds(started, copied),
        rebuild: seconds(copied, rebuiltAt),
        check: seconds(rebuiltAt, checkedAt),
        total: seconds(started, Date.now()),
      },
    }
  } finally {
    stopWatching()
  }
}
