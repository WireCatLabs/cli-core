import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { NextStep } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { holdersOf } from "../../background/processes.js"
import { RULES_VERSION } from "../../conversations/link.js"
import { syncsOneChat } from "../../ports/traits.js"
import { isSealed, sealFile, unsealFile } from "../../sealed.js"
import { fileSchemaOf, SPEAKS, writableBy } from "../../store/compatibility.js"
import type { CacheDatabase } from "../../store/driver.js"
import { migrate } from "../../store/migrations.js"
import { openCache } from "../../store/open.js"
import { storePath } from "../../store/path.js"
import { deleteCopy, type RepairReport, repairStore } from "../../store/repair.js"
import {
  drainNoteIndex,
  fillSearchIndex,
  fillStems,
  involvementStoreOver,
  noteIndexState,
  openSqlite,
  openStore,
  orphanPointers,
  pendingNormalization,
  resetAttachmentWords,
  resetNoteIndex,
  resetSearchIndex,
  resetStems,
  searchIndexState,
  stemmerCache,
  stemsState,
} from "../../store/store.js"
import { environmentOf, outputFor } from "../context.js"
import { destroysNothing, LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { lineOf, nextStep } from "../steps.js"
import { storeInfoCommand } from "../store-info.js"
import { answerOf } from "./ask.js"
import type { Messenger } from "./context.js"
import { ENCRYPT_OPTION, passwordOf } from "./password.js"
import { servingProfiles } from "./serve-command.js"
import { storeTablesCommand } from "./store-tables-command.js"

const SEARCH_INDEXES = ["messages_fts", "chats_fts", "identities_fts"]
/** Contentless: it has no table to be compared with, only its own structure to check. */
const WORD_INDEX = "message_words"

const schemaOf = (database: CacheDatabase) => {
  const file = fileSchemaOf(database)
  return { ...file, writable: writableBy(file) }
}

const count = (database: CacheDatabase, table: string) =>
  Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0)

/** Before version 6 the column does not exist, and a file behind this build is not migrated here. */
const pendingIfKnown = (database: CacheDatabase): number | null =>
  database.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'normalized_text'").get()
    ? pendingNormalization(database)
    : null

const bytesOf = (path: string) => (existsSync(path) ? statSync(path).size : 0)

/** Opens the file as it is. Migrating here would change what the caller asked to look at. */
const reading = async <T>(path: string, read: (database: CacheDatabase) => T): Promise<T> => {
  const database = await openCache(path)
  try {
    return read(database)
  } finally {
    database.close()
  }
}

/** For a command that only reads: the connection refuses writes, and opening sets no journal mode. */
const readingOnly = async <T>(path: string, read: (database: CacheDatabase) => T): Promise<T> => {
  const { database } = await openSqlite(path, { readOnly: true })
  try {
    return read(database)
  } finally {
    database.close()
  }
}

/** `doctor`'s short summary of the store. Must answer for a broken file, so an error is a field. */
export const storeSummary = async (env: NodeJS.ProcessEnv) => {
  const path = storePath(env)
  if (!existsSync(path)) return { path, exists: false }
  try {
    return await reading(path, (database) => {
      const { version, writable } = schemaOf(database)
      return {
        path,
        exists: true,
        schema: version,
        speaks: SPEAKS,
        writable,
        ...(version > 0 ? { chats: count(database, "chats"), messages: count(database, "messages") } : {}),
      }
    })
  } catch (error) {
    return { path, exists: true, error: messageOf(error) }
  }
}

/** A maintenance answer: one item, snake_case, its hints as steps where a registered one fits. */
const result = (command: Command, value: unknown, next: NextStep[] = []) =>
  renderAnswer(command, outputFor(command), itemOf(snakeKeys(value), { next }))

export const storeMaintenanceCommands = (messenger: Messenger): Command[] => [
  storeInfoCommand(),
  checkCommand(messenger),
  migrateCommand(messenger),
  reindexCommand(messenger),
  backupCommand(),
  restoreCommand(messenger),
  decryptCommand(),
  repairCommand(messenger),
  resetCommand(messenger),
  copiesCommand(),
  storeTablesCommand(messenger),
]

/** Renaming tables under a running `serve` would pull them from under its statements. */
const refuseWhileServing = (command: Command, messenger: Messenger) => {
  const serving = servingProfiles(messenger.app, environmentOf(command).env ?? process.env)
  if (serving.length > 0) {
    throw new CliError(
      "validation_error",
      `${messenger.app.command} serve is running for ${serving.join(", ")} — ${serving.map((profile) => `\`${messenger.app.command} ${profile} server stop\``).join(", ")} first`,
    )
  }
}

const repairCommand = (messenger: Messenger): Command =>
  annotate(new Command("repair"), { output: { entity: "store_repair" }, effects: LOCAL_WRITE })
    .summary("repair table shapes while keeping the old tables")
    .description(
      "bring every table to this build's shape, deleting nothing: a table of the wrong shape is kept as a copy beside a new one",
    )
    .option("--dry-run", "say what it would do, and change nothing")
    .action(async function (this: Command) {
      const { renderer, format } = outputFor(this)
      const { dryRun } = this.opts<{ dryRun?: boolean }>()
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) {
        result(this, { path, exists: false })
        return
      }
      if (!dryRun) refuseWhileServing(this, messenger)
      const fresh = await openCache(":memory:")
      try {
        const report = await reading(path, (database) => repairStore(database, fresh, { dryRun: dryRun === true }))
        result(this, { path, ...report })
        if (format === "pretty") for (const note of notesOf(report, messenger.app.command)) renderer.note(note)
      } finally {
        fresh.close()
      }
    })

const notesOf = (report: RepairReport, command: string): string[] => {
  const will = report.dryRun ? "would be" : "was"
  const notes = report.repaired.map((one) => {
    if (one.action === "created") return `${one.table}: ${will} created`
    if (one.action === "columns-added") return `${one.table}: ${one.columnsAdded?.join(", ")} ${will} added`
    const left = (one.rowsInCopy ?? 0) - (one.rowsCopied ?? 0)
    return (
      `${one.table}: ${will} rebuilt; the old one is kept as ${one.copy}, ${one.rowsCopied} of ${one.rowsInCopy} rows copied` +
      (left > 0 ? ` — ${left} did not fit the new shape and are only in the copy` : "") +
      (one.onlyInCopy?.length ? `; columns only in the copy: ${one.onlyInCopy.join(", ")}` : "")
    )
  })
  if (report.repaired.length === 0) notes.push("every table already has this build's shape")
  for (const { table, what } of report.mismatches) notes.push(`${table}: ${what} — left for you to decide`)
  for (const { table, rows } of report.foreignKeyViolations)
    notes.push(`${table}: ${rows} rows point at a row that is not there`)
  if (report.copies.length > 0) {
    notes.push(
      `copies kept: ${report.copies.map((one) => `${one.name} (${one.rows} rows)`).join(", ")} — ` +
        `\`${command} store copies delete <name>\` deletes one once you have looked at it`,
    )
  }
  return notes
}

const copiesCommand = (): Command =>
  new Command("copies").description("the tables `store repair` kept as copies").addCommand(
    annotate(new Command("delete"), { output: { entity: "store_copy_removal" }, effects: LOCAL_WRITE })
      .description("delete one copy `store repair` kept, named exactly; refuses any other table")
      .argument("<name>", "the copy's name, as `store repair` printed it")
      .action(async function (this: Command, name: string) {
        const path = storePath(environmentOf(this).env ?? process.env)
        if (!existsSync(path)) throw new CliError("not_found", `no store at ${path}`)
        const deleted = await reading(path, (database) => deleteCopy(database, name))
        result(this, { path, deleted })
      }),
  )

/**
 * Reports and never repairs. The per-chat completeness is what tells "nothing was said" from "not
 * fetched" (NEED-399 A). Times are the chat's newest message by the messenger's list against the
 * newest message held, not `sync_ranges`: those are in message ids, which a chat list does not give.
 */
const checkCommand = (messenger: Messenger): Command =>
  annotate(new Command("check"), { output: { entity: "store_check" }, effects: LOCAL_READ })
    .summary("check the local archive for problems")
    .description("whether the store is healthy — integrity, search indexes, disk, and which chats are behind")
    .action(async function (this: Command) {
      const { renderer } = outputFor(this)
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) {
        result(this, { path, exists: false, ok: true })
        return
      }
      let answer: Awaited<ReturnType<typeof inspect>>
      try {
        answer = await inspect(path)
      } catch (error) {
        result(this, { path, exists: true, ok: false, opens: false, error: messageOf(error) })
        return
      }
      const { command } = messenger.app
      const next = new Map<string, NextStep>()
      const step = (id: string, args: Record<string, unknown> = {}) => {
        if (!next.has(id)) next.set(id, nextStep(id, { args }))
      }
      const words = answer.wordIndex
      const stems = answer.stemIndex
      if (answer.pendingNormalization) step("store.migrate")
      if (words && (words.filledThrough < words.watermark || (words.ready && !words.termsReady))) step("store.migrate")
      if (stems?.cause === "stemmer_changed") step("store.reindex")
      else if (stems && !stems.ready) step("store.migrate")
      const behind = answer.chatsBehind.find((chat) => chat.provider === messenger.provider)
      if (behind && messenger.history !== "store") step("messages.sync")
      else if (behind && syncsOneChat(messenger)) step("messages.sync", { chat: behind.chat })
      result(this, answer, [...next.values()])
      if (answer.schema.version < SPEAKS) {
        renderer.note(
          `the file is behind this build — a copy first, \`${command} store backup <file>\`, then \`${command} store migrate\``,
        )
      } else if (!answer.schema.writable) {
        renderer.note(
          `the file is at schema ${answer.schema.version} and needs at least ${answer.schema.minCompatible}; ` +
            `this build speaks ${SPEAKS} — \`${command} upgrade\``,
        )
      } else if (answer.schema.version > SPEAKS) {
        renderer.note(
          `the file is at schema ${answer.schema.version}, newer than this build's ${SPEAKS}, and this build may still write it`,
        )
      }
      const orphans = answer.orphanPointers.reduce((sum, { count }) => sum + count, 0)
      if (orphans > 0)
        renderer.note(
          `${orphans} pointers name a row that is gone or a type the store does not know — see orphan_pointers`,
        )
      const older = answer.conversations.filter((chat) => chat.provider === messenger.provider && !chat.current).length
      if (older > 0) {
        renderer.note(
          `${older} chats' conversations were built by older rules — \`${command} conversations links rebuild --chat <chat>\``,
        )
      }
    })

const inspect = (path: string) =>
  reading(path, (database) => {
    const schema = schemaOf(database)
    const integrity = database
      .prepare("PRAGMA quick_check(20)")
      .all()
      .map((row) => String(row.quick_check))
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all().length
    const wordIndex = searchIndexState(database)
    const stems = stemsState(database)
    const searchIndexes = Object.fromEntries([
      ...(schema.version > 0 ? SEARCH_INDEXES.map((index) => [index, indexIntegrity(database, index)]) : []),
      ...(wordIndex ? [[WORD_INDEX, indexIntegrity(database, WORD_INDEX, 0)]] : []),
      ...(stems ? [["message_stems", indexIntegrity(database, "message_stems", 0)]] : []),
      ...(schema.version > 0 ? [["attachment_words", indexIntegrity(database, "attachment_words", 0)]] : []),
    ])
    const size = bytesOf(path) + bytesOf(`${path}-wal`)
    const { bavail, bsize } = statfsSync(dirname(path))
    const free = Number(bavail) * Number(bsize)
    const behind = schema.version > 0 ? chatsBehind(database) : []
    const checks = {
      schema: schema.version >= SPEAKS && schema.writable,
      integrity: integrity.length === 1 && integrity[0] === "ok",
      foreignKeys: foreignKeys === 0,
      searchIndexes: Object.values(searchIndexes).every((state) => state === "ok"),
      // A backup or a VACUUM needs about as much again.
      disk: free >= size,
    }
    return {
      path,
      exists: true,
      opens: true,
      ok: Object.values(checks).every(Boolean),
      checks,
      schema: { ...schema, speaks: SPEAKS },
      integrity,
      foreignKeyViolations: foreignKeys,
      searchIndexes,
      disk: { free, needed: size },
      pendingNormalization: pendingIfKnown(database),
      wordIndex: wordIndex ?? null,
      stemIndex: stems ?? null,
      chatsBehind: behind,
      // Reported, not a failed check: a tag on a deleted message is untidy, not a broken store.
      orphanPointers: schema.version > 0 ? orphanPointers(database) : [],
      conversations: conversationsBuilt(database),
      vectors: vectorsHeld(database),
      notApplicable: { extensions: "SQLite needs none" },
    }
  })

/** `rank = 1` compares the index with its table; without it a stale external-content index passes. */
const indexIntegrity = (database: CacheDatabase, index: string, rank = 1): string => {
  try {
    database.prepare(`INSERT INTO ${index} (${index}, rank) VALUES ('integrity-check', ${rank})`).run()
    return "ok"
  } catch (error) {
    return messageOf(error)
  }
}

/**
 * Vectors per model, and how many no chunk of any build points at any more — a rebuild that changed a
 * conversation's text leaves its old vector behind until `conversations embed clear` (phase 5).
 */
const vectorsHeld = (database: CacheDatabase) => {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'embeddings'").get()
  if (!exists) return null
  const models = Object.fromEntries(
    database
      .prepare("SELECT model, count(*) AS n FROM embeddings GROUP BY model ORDER BY model")
      .all()
      .map((row) => [String(row.model), Number(row.n)]),
  )
  const unused = database
    .prepare(
      `SELECT count(*) AS n FROM embeddings v
       WHERE NOT EXISTS (SELECT 1 FROM chunks k WHERE k.content_hash = v.content_hash)`,
    )
    .get()
  return { models, unused: Number(unused?.n ?? 0) }
}

/**
 * Per chat whose conversations were built: by which rules, whether those are this build's, and how many
 * of the agent's links went stale — their message changed after they were written (phase 3 plan C4).
 */
const conversationsBuilt = (database: CacheDatabase) => {
  const exists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_state'")
    .get()
  if (!exists) return []
  return database
    .prepare(
      `SELECT a.provider, a.external_id AS account, c.external_id AS chat, c.title, s.built_at, s.algorithm_version,
         (SELECT count(*) FROM message_links l WHERE l.chat_id = c.id AND l.source = 'agent' AND l.stale_at IS NOT NULL)
           AS stale
       FROM conversation_state s JOIN chats c ON c.id = s.chat_id JOIN accounts a ON a.id = c.account_id
       ORDER BY s.built_at DESC`,
    )
    .all()
    .map((row) => ({
      provider: String(row.provider),
      account: String(row.account),
      chat: String(row.chat),
      title: row.title === null ? null : String(row.title),
      builtAt: row.built_at === null ? null : isoOf(row.built_at),
      rulesVersion: row.algorithm_version === null ? null : Number(row.algorithm_version),
      current: Number(row.algorithm_version) === RULES_VERSION,
      staleAgentLinks: Number(row.stale),
    }))
}

const chatsBehind = (database: CacheDatabase) =>
  database
    .prepare(
      `SELECT a.provider, a.external_id AS account, c.external_id AS chat, c.title, c.last_message_at AS newest,
         (SELECT max(m.sent_at) FROM messages m WHERE m.chat_id = c.id) AS held, c.updated_at AS refreshed
       FROM chats c JOIN accounts a ON a.id = c.account_id
       WHERE c.last_message_at IS NOT NULL
       ORDER BY c.last_message_at DESC`,
    )
    .all()
    .filter((row) => row.held === null || Number(row.held) < Number(row.newest))
    .map((row) => ({
      provider: String(row.provider),
      account: String(row.account),
      chat: String(row.chat),
      title: row.title === null ? null : String(row.title),
      newest: isoOf(row.newest),
      held: row.held === null ? null : isoOf(row.held),
      refreshed: isoOf(row.refreshed),
    }))

const migrateCommand = (messenger: Messenger): Command =>
  annotate(new Command("migrate"), { output: { entity: "store_migration" }, effects: LOCAL_WRITE })
    .summary("migrate an older local archive")
    .description(
      "bring the store up to this build's schema, then normalize, index and stem the messages and notes stored before it",
    )
    .action(async function (this: Command) {
      const { renderer } = outputFor(this)
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) {
        result(this, { path, exists: false })
        renderer.note(`no store yet — the first \`${messenger.app.command}\` command that reads a chat creates it`)
        return
      }
      const answer = await reading(path, (database) => {
        const from = schemaOf(database).version
        migrate(database, { command: messenger.app.command, version: messenger.app.version })
        const { normalized, indexed, terms } = buildWordIndex(database, (note) => renderer.note(note))
        const stemmed = buildStems(database, (note) => renderer.note(note))
        const notes = buildNoteIndex(database, (note) => renderer.note(note))
        return {
          path,
          exists: true,
          from,
          to: schemaOf(database).version,
          normalized,
          indexed,
          terms,
          ...stemmed,
          ...notes,
        }
      })
      result(this, answer)
    })

/** Normalizes, indexes and builds the typo vocabulary, saying how far each has gone. */
const buildWordIndex = (database: CacheDatabase, note: (text: string) => void) => {
  const state = searchIndexState(database)
  const pending = pendingNormalization(database)
  if (pending > 0) note(`normalizing ${pending} messages, in batches; stopping loses nothing`)
  if (state && state.filledThrough < state.watermark) note(`indexing words up to message ${state.watermark}`)
  return fillSearchIndex(database, {
    onBatch: (step, done) => note(step === "normalized" ? `${done} of ${pending} normalized` : `${done} ${step}`),
  })
}

/**
 * Stems what is left, after rebuilding stems made by other stemmer choices than the store's setting —
 * only here and in `store rebuild`, never in a search's quick fill.
 */
export const buildStems = (database: CacheDatabase, note: (text: string) => void, { force = false } = {}) => {
  const before = stemsState(database)
  if (!before) return { stemmed: 0 }
  if (resetStems(database, { force }) && before.built !== null) {
    note(`stems were built by ${before.built} — rebuilding them with ${before.wanted}`)
  }
  const state = stemsState(database)
  if (state && state.filledThrough < state.watermark) note(`stemming up to message ${state.watermark}`)
  const { stemmed, drained } = fillStems(database, { onBatch: (step, done) => note(`${done} ${step}`) })
  return { stemmed: stemmed + drained }
}

/** Indexes the notes written since — all of them after `store rebuild` queued them again. */
const buildNoteIndex = (database: CacheDatabase, note: (text: string) => void, { reset = false } = {}) => {
  if (reset) resetNoteIndex(database)
  const pending = noteIndexState(database)?.pending ?? 0
  if (pending > 0) note(`indexing ${pending} notes`)
  return { notesIndexed: drainNoteIndex(database, stemmerCache()) }
}

const reindexCommand = (messenger: Messenger): Command =>
  destroysNothing(annotate(new Command("rebuild"), { output: { entity: "store_reindex" }, effects: LOCAL_WRITE }))

    .summary("rebuild the local archive's search indexes")
    .description(
      "rebuild the word index, its typo vocabulary, the stems, the files' word index, the notes' indexes and who took part in what, from what is stored; loses nothing",
    )
    .action(async function (this: Command) {
      const { renderer } = outputFor(this)
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) {
        result(this, { path, exists: false })
        return
      }
      const answer = await reading(path, (database) => {
        const schema = schemaOf(database)
        if (!schema.writable) {
          throw new CliError(
            "configuration_error",
            `the message store was written by a newer version (schema ${schema.version}, needs at least ` +
              `${schema.minCompatible}; this one speaks ${SPEAKS}) — upgrade this tool`,
          )
        }
        if (schema.version < SPEAKS) {
          throw new CliError(
            "validation_error",
            `the store is behind this build — \`${lineOf(this, "store migrate")}\` first`,
          )
        }
        resetSearchIndex(database)
        const fileTexts = resetAttachmentWords(database)
        const words = buildWordIndex(database, (note) => renderer.note(note))
        return {
          path,
          exists: true,
          ...words,
          fileTexts,
          ...buildStems(database, (note) => renderer.note(note), { force: true }),
          ...buildNoteIndex(database, (note) => renderer.note(note), { reset: true }),
          involvements: involvementStoreOver({ database, now: Date.now }).rebuild(),
        }
      })
      result(this, answer)
    })

/** A consistent copy of a store that may be in use. Never overwrites a file. */
const vacuumInto = async (path: string, target: string) => {
  // VACUUM INTO fills an empty file and keeps its mode; a file it creates itself is readable by all.
  writeFileSync(target, "", { flag: "wx", mode: 0o600 })
  try {
    await reading(path, (database) => database.prepare("VACUUM INTO ?").run(target))
  } catch (error) {
    rmSync(target, { force: true })
    throw error
  }
}

const stampNow = () => new Date().toISOString().replace(/[:.]/g, "-")

const backupCommand = (): Command =>
  destroysNothing(annotate(new Command("backup"), { output: { entity: "store_backup" }, effects: LOCAL_WRITE }))
    .description("copy the store into a new file, while it is in use; never overwrites a file")
    .argument("<file>", "the new file")
    .option(...ENCRYPT_OPTION)
    .action(async function (this: Command, file: string) {
      const { encrypt } = this.opts<{ encrypt?: boolean }>()
      const path = storePath(environmentOf(this).env ?? process.env)
      const target = resolve(file)
      if (!existsSync(path)) throw new CliError("not_found", `no store at ${path} to back up`)
      if (existsSync(target))
        throw new CliError("validation_error", `${target} exists — a backup never overwrites a file`)
      const password = encrypt ? await passwordOf(this, { twice: true }) : undefined
      // SQLite copies only into a file. Sealed, that plain copy goes beside the store, which holds the
      // same text already — never beside the target, which may be a synced folder or a removable disk.
      const copyAt = password === undefined ? target : `${path}.backup-${process.pid}`
      await vacuumInto(path, copyAt)
      try {
        const copy = await reading(copyAt, (database) => ({
          schema: schemaOf(database),
          rows: { chats: count(database, "chats"), messages: count(database, "messages") },
        }))
        if (password !== undefined) await sealFile(copyAt, target, password)
        result(this, {
          path: target,
          from: path,
          bytes: bytesOf(target),
          schema: copy.schema.version,
          rows: copy.rows,
          ...(password === undefined ? {} : { encrypted: true }),
        })
      } catch (error) {
        if (password === undefined) rmSync(target, { force: true })
        throw error
      } finally {
        if (password !== undefined) rmSync(copyAt, { force: true })
      }
    })

/** The only way back into a sealed file: the format is this tool's own. */
const decryptCommand = (): Command =>
  annotate(new Command("decrypt"), { output: { entity: "store_decrypt" }, effects: LOCAL_WRITE })
    .description("open a file written with --encrypt into a new file; asks for its password")
    .argument("<file>", "a file `store backup --encrypt` or `store export --encrypt` wrote")
    .requiredOption("--output <file>", "the new file, readable only by you")
    .action(async function (this: Command, file: string) {
      const { output } = this.opts<{ output: string }>()
      const from = resolve(file)
      const to = resolve(output)
      if (!existsSync(from)) throw new CliError("not_found", `no file at ${from}`)
      if (!isSealed(from)) throw new CliError("validation_error", `${from} was not written with --encrypt`)
      if (existsSync(to)) throw new CliError("validation_error", `${to} exists — never overwritten`)
      await unsealFile(from, to, await passwordOf(this, { twice: false }))
      result(this, { path: to, from, bytes: bytesOf(to) })
    })

/**
 * Puts a backup in place of the store, keeping the store it replaces beside it. Refuses while any
 * process has the file open — it would go on writing to the file set aside — or while this CLI's
 * `serve` runs: that opens the store on its first write, so until then it holds nothing to see.
 */
const restoreCommand = (messenger: Messenger): Command =>
  annotate(new Command("restore"), { output: { entity: "store_restore" }, effects: LOCAL_WRITE })
    .summary("restore a backup while keeping the current store")
    .description("put a backup in place of the store; the store it replaces is kept beside it, never deleted")
    .argument("<file>", "a file `store backup` wrote; one written with --encrypt asks for its password")
    .action(async function (this: Command, file: string) {
      const path = storePath(environmentOf(this).env ?? process.env)
      const given = resolve(file)
      if (!existsSync(given)) throw new CliError("not_found", `no file at ${given}`)
      refuseWhileServing(this, messenger)
      if (!isSealed(given)) return restoreFrom(this, messenger, given, given)
      const opened = `${path}.unsealing-${process.pid}`
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      try {
        await unsealFile(given, opened, await passwordOf(this, { twice: false }))
        await restoreFrom(this, messenger, opened, given)
      } finally {
        rmSync(opened, { force: true })
      }
    })

const restoreFrom = async (command: Command, messenger: Messenger, backup: string, given: string) => {
  const { renderer } = outputFor(command)
  const path = storePath(environmentOf(command).env ?? process.env)
  if (existsSync(path) && realpathSync(backup) === realpathSync(path)) {
    throw new CliError("validation_error", `${backup} is the store itself`)
  }
  const schema = await backupSchema(backup)

  const stamp = stampNow()
  const kept = existsSync(path) ? `${path}.before-restore-${stamp}` : null
  if (kept) {
    const waitMs = environmentOf(command).storeLockWaitMs
    await quiesce(path, messenger, "restore", (message) => renderer.warn(message), waitMs)
  } else mkdirSync(dirname(path), { recursive: true, mode: 0o700 })

  const incoming = `${path}.restoring-${stamp}`
  copyFileSync(backup, incoming, constants.COPYFILE_EXCL)
  chmodSync(incoming, 0o600)
  if (kept) {
    renameSync(path, kept)
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${kept}${suffix}`)
  }
  renameSync(incoming, path)

  result(command, { path, restoredFrom: given, keptAt: kept, schema: schema.version })
  if (kept) renderer.note(`the store it replaced is kept at ${kept}`)
  // One that has not touched the store yet holds nothing open, and was not seen.
  renderer.note("restart every serve and mcp of either CLI that was running, so they read the restored store")
  if (schema.version < SPEAKS) {
    renderer.note(
      `the backup is behind this build; the next command migrates it — \`${lineOf(command, "store migrate")}\` now`,
    )
  }
}

const backupSchema = async (backup: string) => {
  let read: { integrity: string; schema: ReturnType<typeof schemaOf> }
  try {
    read = await reading(backup, (database) => ({
      integrity: String(database.prepare("PRAGMA quick_check(1)").get()?.quick_check),
      schema: schemaOf(database),
    }))
  } catch (error) {
    throw new CliError("validation_error", `${backup} is not a store this tool can read: ${messageOf(error)}`)
  }
  const { integrity, schema } = read
  if (schema.version === 0) throw new CliError("validation_error", `${backup} holds no message store`)
  if (integrity !== "ok") throw new CliError("validation_error", `${backup} is damaged: ${integrity}`)
  if (!schema.writable) {
    throw new CliError(
      "configuration_error",
      `the backup was written by a newer version (schema ${schema.version}, needs at least ` +
        `${schema.minCompatible}; this one speaks ${SPEAKS}) — upgrade this tool`,
    )
  }
  return schema
}

const STORE_LOCK_WAIT_MS = 1_000

/**
 * No other process has the file open, no write is under way, and the write-ahead log is folded in,
 * so the file set aside is whole on its own. In WAL mode SQLite cannot say who has the file open —
 * `EXCLUSIVE` behaves as `IMMEDIATE` — so that is asked of the system.
 */
const quiesce = async (
  path: string,
  messenger: Messenger,
  then: string,
  warn: (message: string) => void,
  waitMs = STORE_LOCK_WAIT_MS,
) => {
  const { command } = messenger.app
  const files = [path, `${path}-wal`, `${path}-shm`]
    .filter((file) => existsSync(file))
    .map((file) => realpathSync(file))
  const holders = holdersOf(files)
  if (holders === undefined) {
    warn(`this system cannot say which processes have the store open — restart every running serve and mcp after this`)
  } else if (holders.length > 0) {
    throw new CliError(
      "validation_error",
      `the store is open in process ${holders.join(", ")} — stop it first (a serve: \`${command} <profile> server stop\`, ` +
        `or the other CLI's; an mcp: its client), then ${then}`,
    )
  }
  const database = await openCache(path)
  try {
    database.exec(`PRAGMA busy_timeout = ${waitMs}`)
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    try {
      database.exec("BEGIN IMMEDIATE")
    } catch {
      throw new CliError("validation_error", "a write to the store is under way — try again in a moment")
    }
    database.exec("ROLLBACK")
  } finally {
    database.close()
  }
}

/**
 * For a store this build cannot migrate, or one the owner wants empty: a backup beside it, then an empty
 * store at this build's schema. The backup is made before anything is deleted, and its path is said before
 * the delete. A new file rather than `DELETE FROM` every table: deleted rows would stay readable in free
 * pages until a VACUUM, and every table comes back in this build's shape.
 */
const resetCommand = (messenger: Messenger): Command =>
  annotate(new Command("reset"), { output: { entity: "store_reset" }, effects: LOCAL_WRITE })
    .summary("back up the local archive and replace it with an empty one")
    .description(
      "back the store up beside itself, then delete it and start an empty one at this build's schema; asks first, or --yes",
    )
    .option("--no-backup", "delete the store without backing it up first")
    .option("--dry-run", "list every table it would empty, with its rows, and delete nothing")
    .action(async function (this: Command, { backup: keep, dryRun }: { backup: boolean; dryRun?: boolean }) {
      const { renderer } = outputFor(this)
      const { command } = messenger.app
      const env = environmentOf(this).env ?? process.env
      const path = storePath(env)
      if (!existsSync(path)) {
        result(this, { path, exists: false, reset: false })
        renderer.note(
          `no store at ${path} — nothing to reset; the first \`${command}\` command that reads a chat creates it`,
        )
        return
      }
      if (dryRun) {
        result(this, await resetPreview(path, messenger, env, keep))
        return
      }
      refuseWhileServing(this, messenger)
      if (this.optsWithGlobals<{ yes?: boolean }>().yes !== true) {
        const what = `this deletes the store at ${path} and starts an empty one, ${keep ? "after a backup beside it" : "with no backup"}`
        const answer = await answerOf(this, `${what}. Go ahead? [y/N] `)
        if (answer === null) throw new CliError("confirmation_required", `${what} — add --yes to go ahead`)
        if (!/^\s*y(es)?\s*$/i.test(answer)) throw new CliError("cancelled", "cancelled — the store is unchanged")
      }
      await quiesce(path, messenger, "reset", (message) => renderer.warn(message), environmentOf(this).storeLockWaitMs)

      const backup = keep ? `${path}.backup-${stampNow()}` : null
      let backedUp = null
      if (backup) {
        try {
          await vacuumInto(path, backup)
        } catch (error) {
          throw new CliError(
            "validation_error",
            `could not back the store up, so it was not reset: ${messageOf(error)}`,
          )
        }
        backedUp = await reading(backup, (database) => {
          const schema = schemaOf(database).version
          return {
            schema,
            rows: schema > 0 ? { chats: count(database, "chats"), messages: count(database, "messages") } : {},
          }
        })
        renderer.note(`backed the store up to ${backup}`)
      }

      for (const suffix of STORE_PARTS) rmSync(`${path}${suffix}`, { force: true })
      await (await openStore({ path, command })).close()
      const schema = await reading(path, (database) => schemaOf(database).version)

      result(this, { path, exists: true, reset: true, backup, backedUp, schema })
      renderer.note(
        backup
          ? `the store is empty at schema ${schema}; \`${command} store restore ${backup}\` puts the old one back once a build can read it`
          : `the store is empty at schema ${schema}; there is no backup`,
      )
    })

const STORE_PARTS = ["", "-wal", "-shm"]

/**
 * What a reset would delete, read without a write lock so it answers while a sync runs. `in_use` is what the
 * real run would refuse over now; `null` where this system cannot say who has the file open.
 */
const resetPreview = async (path: string, messenger: Messenger, env: NodeJS.ProcessEnv, keep: boolean) => {
  const files = STORE_PARTS.map((suffix) => `${path}${suffix}`).filter((file) => existsSync(file))
  const holders = holdersOf(files.map((file) => realpathSync(file)))
  const serving = servingProfiles(messenger.app, env).length > 0
  const read = await readingOnly(path, (database) => ({
    schema: schemaOf(database).version,
    tables: emptiedTables(database),
  }))
  return {
    path,
    exists: true,
    reset: false,
    dryRun: true,
    files,
    bytes: files.reduce((sum, file) => sum + bytesOf(file), 0),
    schema: read.schema,
    tables: read.tables,
    backupFirst: keep,
    inUse: serving || (holders === undefined ? null : holders.length > 0),
  }
}

/** The tables that hold data; a search index and its shadow tables are rebuilt from them, so they are left out. */
const emptiedTables = (database: CacheDatabase) => {
  const all = database
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => ({ name: String(row.name), virtual: /^\s*CREATE\s+VIRTUAL/i.test(String(row.sql)) }))
  const indexes = all.filter((table) => table.virtual).map((table) => `${table.name}_`)
  return all
    .filter((table) => !table.virtual && table.name !== "schema_migrations")
    .filter((table) => !indexes.some((prefix) => table.name.startsWith(prefix)))
    .map((table) => ({ name: table.name, rows: count(database, `"${table.name}"`) }))
}

const isoOf = (value: unknown) => new Date(Number(value)).toISOString()

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
