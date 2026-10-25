import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { holdersOf } from "../../background/processes.js"
import { RULES_VERSION } from "../../conversations/link.js"
import { DEFAULT_TASK_CATEGORIES } from "../../domain/task-categories.js"
import { ENTITIES } from "../../entities/index.js"
import { MIGRATIONS, migrate } from "../../store/migrations.js"
import { openCache, openFile } from "../../store/open.js"
import { openStore } from "../../store/store.js"
import { configCommand } from "../config-command.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { storeCommand } from "./archive-commands.js"
import type { Messenger } from "./context.js"
import { mentionsCommand } from "./mentions-command.js"
import { messagesCommand } from "./messages-command.js"
import { lockPath } from "./serve-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const latest = MIGRATIONS.at(-1)?.version ?? 0
const DAY = 24 * 60 * 60 * 1000

const envFor = () => {
  const root = mkdtempSync(join(tmpdir(), "store-maintenance-"))
  return {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
}

/** A file at `version`, one chat whose list says a message came a day after the newest one held. */
const seeded = async (env: NodeJS.ProcessEnv, version = latest) => {
  const database = await openCache(String(env.MESSAGING_STORE))
  migrate(database, { migrations: MIGRATIONS.filter((migration) => migration.version <= version) })
  database.exec(
    `INSERT INTO accounts (id, provider, external_id, created_at,updated_at) VALUES (1, 'chat', '500', 0,0)`,
  )
  database.exec(
    `INSERT INTO chats (id, account_id, external_id, kind, title, last_message_at, updated_at,created_at)
     VALUES (1, 1, '7', 'group', 'Book club', ${2 * DAY}, ${DAY},0), (2, 1, '8', 'private', 'Ana', ${DAY}, ${DAY},0)`,
  )
  database.exec(
    `INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, created_at, source,updated_at)
     VALUES (1, 1, '1', ${DAY}, 'Hola, ¿qué tal?', 0, 'fetch',0), (2, 1, '1', ${DAY}, 'Ёлка', 0, 'fetch',0)`,
  )
  return database
}

const call = async (argv: string[], env: NodeJS.ProcessEnv, storeLockWaitMs?: number) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => {
      throw new Error("the store's maintenance never connects")
    },
    chatArgument: "a chat",
  }
  const streams = captureStreams()
  const commands = () => [
    storeCommand(messenger),
    messagesCommand(messenger),
    mentionsCommand(messenger),
    configCommand(app, settingsFor(app)),
  ]
  const code = await run(
    argv,
    { app, commands },
    { streams, tty: false, env, ...(storeLockWaitMs ? { storeLockWaitMs } : {}) },
  )
  const body = JSON.parse(streams.stdout[0] ?? "null")
  if (argv[0] === "store" && argv.includes("--json") && body?.item) {
    const names = {
      info: "store_info",
      check: "store_check",
      migrate: "store_migration",
      reindex: "store_reindex",
      backup: "store_backup",
      decrypt: "store_decrypt",
      restore: "store_restore",
      reset: "store_reset",
      repair: "store_repair",
      copies: "store_copy_removal",
    } as const
    const entity = names[argv[1] as keyof typeof names]
    if (entity) v.parse(ENTITIES[entity] as v.GenericSchema, body.item)
  }

  return { code, stdout: streams.stdout, stderr: streams.stderr, body, answer: body?.item ?? body }
}

describe("store info", () => {
  it("projects store fields and refuses an unknown reset field before changing the store", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    const projected = await call(["store", "info", "--json=path,rows.messages"], env)
    expect(projected.code, projected.stderr.join(" ")).toBe(0)
    expect(projected.answer).toEqual({ path: env.MESSAGING_STORE, rows: { messages: 2 } })
    const refused = await call(["store", "reset", "--yes", "--json=unknown_field"], env)
    expect(refused.code).not.toBe(0)
    expect(JSON.parse(refused.stderr.join("")).error.reason).toBe("output.unknown-field")
    expect((await call(["store", "info", "--json"], env)).answer.rows.messages).toBe(2)
  })

  it("says there is no file rather than creating one", async () => {
    const env = envFor()
    const { answer } = await call(["store", "info", "--json"], env)
    expect(answer).toMatchObject({ path: env.MESSAGING_STORE, exists: false, schema: { reason: "missing" } })
    expect(existsSync(String(env.MESSAGING_STORE))).toBe(false)
  })

  it("reads a baseline file without changing its normalization state", async () => {
    const env = envFor()
    ;(await seeded(env, latest)).close()

    const { answer } = await call(["store", "info", "--json"], env)
    expect(answer).toMatchObject({
      schema: { version: latest, speaks: latest, writable: true },
      rows: { accounts: 1, chats: 2, messages: 2 },
      pending_normalization: 2,
    })
    expect((await call(["store", "info", "--json"], env)).answer.schema.version).toBe(latest)
  })
})

describe("store info contents", () => {
  it("**breaks the rows down by provider, chat kind, account, UTC year and attachment kind, over every account**", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec(`
      INSERT INTO accounts (id, provider, external_id, name, created_at, updated_at)
        VALUES (2, 'email', 'synthetic@example.com', NULL, 0, 0);
      INSERT INTO email_threads (id, account_id, external_id, created_at, updated_at) VALUES (1, 2, 't1', 0, 0);
      INSERT INTO emails (id, account_id, email_thread_id, external_id, created_at, updated_at)
        VALUES (1, 2, 1, 'e1', 0, 0), (2, 2, 1, 'e2', 0, 0);
      INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, created_at, source, updated_at)
        VALUES (1, 1, '2', ${Date.UTC(2023, 11, 31, 23, 30)}, 'Synthetic', 0, 'fetch', 0);
      INSERT INTO attachments (attachable_type, attachable_id, position, kind, size, created_at, updated_at)
        VALUES ('message', 1, 0, 'photo', 100, 0, 0), ('message', 2, 0, 'photo', NULL, 0, 0),
               ('email', 1, 0, 'file', 7, 0, 0);
    `)
    database.close()

    const { answer } = await call(["store", "info", "--json"], env)
    expect(answer.rows).toMatchObject({ accounts: 2, messages: 3, emails: 2, documents: 0, meetings: 0, events: 0 })
    expect(answer.by_provider).toEqual([
      { provider: "chat", accounts: 1, chats: 2, messages: 3, emails: 0, documents: 0, meetings: 0 },
      { provider: "email", accounts: 1, chats: 0, messages: 0, emails: 2, documents: 0, meetings: 0 },
    ])
    expect(answer.by_chat_kind).toEqual([
      { provider: "chat", kind: "group", chats: 1, messages: 2 },
      { provider: "chat", kind: "private", chats: 1, messages: 1 },
    ])
    expect(answer.by_account).toEqual([
      { provider: "chat", account_id: 1, name: null, chats: 2, messages: 3, emails: 0, documents: 0, meetings: 0 },
      { provider: "email", account_id: 2, name: null, chats: 0, messages: 0, emails: 2, documents: 0, meetings: 0 },
    ])
    expect(JSON.stringify(answer)).not.toContain("synthetic@example.com")
    expect(answer.by_year).toEqual([
      { provider: "chat", year: 1970, messages: 2 },
      { provider: "chat", year: 2023, messages: 1 },
    ])
    expect(answer.by_attachment_kind).toEqual([
      { type: "email", kind: "file", count: 1, bytes: 7 },
      { type: "message", kind: "photo", count: 2, bytes: 100 },
    ])
  })

  it("opens the file read-only, leaving a store in rollback journal mode as it was", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec("PRAGMA journal_mode = DELETE")
    database.close()

    expect((await call(["store", "info", "--json"], env)).code).toBe(0)
    const after = await openFile(String(env.MESSAGING_STORE))
    expect(after.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete")
    after.close()
  })
})

describe("store check", () => {
  it("**prints one JSON value on stdout, its steps in it**", async () => {
    const env = envFor()
    ;(await seeded(env)).close()

    const { code, stdout, body, answer } = await call(["store", "check", "--json"], env)
    expect(code).toBe(0)
    expect(stdout).toHaveLength(1)
    expect(answer).toMatchObject({
      ok: true,
      integrity: ["ok"],
      foreign_key_violations: 0,
      search_indexes: { messages_fts: "ok", chats_fts: "ok", identities_fts: "ok" },
    })
    expect(body.next).toContainEqual(expect.objectContaining({ step: "messages.sync" }))
  })

  it("names a note left on a deleted message, and a pointer of an unknown type, as orphans", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec(
      `INSERT INTO notes (notable_type, notable_id, body, created_at, updated_at)
       VALUES ('message', 1, 'kept', 0, 0), ('message', 2, 'orphaned', 0, 0), ('gizmo', 1, 'unknown', 0, 0);
       DELETE FROM messages WHERE id = 2`,
    )
    database.close()

    const { answer, stderr } = await call(["store", "check", "--json"], env)
    expect(answer.orphan_pointers).toEqual([
      { table: "notes", pointer: "notable", type: "gizmo", count: 1, known: false },
      { table: "notes", pointer: "notable", type: "message", count: 1, known: true },
    ])
    expect(stderr.join("\n")).toContain("2 pointers name a row that is gone")
  })

  it("names the chat whose held history stops before its newest message", async () => {
    const env = envFor()
    ;(await seeded(env)).close()

    const { answer } = await call(["store", "check", "--json"], env)
    expect(answer.chats_behind).toEqual([
      {
        provider: "chat",
        account: "500",
        chat: "7",
        title: "Book club",
        newest: new Date(2 * DAY).toISOString(),
        held: new Date(DAY).toISOString(),
        refreshed: new Date(DAY).toISOString(),
      },
    ])
  })

  it("names the chats whose conversations older rules built, and the agent links gone stale", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec(
      `INSERT INTO conversation_state (chat_id, enabled_at, built_at, algorithm_version, current_build)
       VALUES (1, 0, ${DAY}, 1, 1), (2, 0, ${2 * DAY}, ${RULES_VERSION}, 1)`,
    )
    database.exec(
      `INSERT INTO message_links (chat_id, message_id, parent_id, source, kind, confidence, method, created_at, stale_at,updated_at)
       SELECT chat_id, id, NULL, 'agent', 'start', 0.9, 'model', 0, ${DAY} ,0 FROM messages WHERE chat_id = 1`,
    )
    database.close()

    const { answer, stderr } = await call(["store", "check", "--json"], env)
    expect(answer.conversations).toEqual([
      expect.objectContaining({ chat: "8", rules_version: RULES_VERSION, current: true, stale_agent_links: 0 }),
      expect.objectContaining({ chat: "7", rules_version: 1, current: false, stale_agent_links: 1 }),
    ])
    expect(stderr.join("\n")).toContain(
      "1 chats' conversations were built by older rules — `chat conversations links rebuild",
    )
  })

  it("**reports a search index that no longer matches its table**, and repairs nothing", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec("DROP TRIGGER messages_fts_au")
    database.exec("UPDATE messages SET text = 'changed behind the index' WHERE id = 1")
    database.close()

    const first = (await call(["store", "check", "--json"], env)).answer
    expect(first.ok).toBe(false)
    expect(first.checks.search_indexes).toBe(false)
    expect(first.search_indexes.messages_fts).not.toBe("ok")
    expect((await call(["store", "check", "--json"], env)).answer.search_indexes).toEqual(first.search_indexes)
  })
})

describe("store check on a file a newer build wrote", () => {
  const ahead = async (minCompatible: number) => {
    const env = envFor()
    const database = await seeded(env)
    migrate(database, { migrations: [...MIGRATIONS, { version: latest + 1, minCompatible, statements: [] }] })
    database.close()
    return call(["store", "check", "--json"], env)
  }

  it("**passes the schema check when this build may still write the file**", async () => {
    const { answer, stderr } = await ahead(1)
    expect(answer.checks.schema).toBe(true)
    expect(answer.schema).toMatchObject({ version: latest + 1, min_compatible: 1, speaks: latest })
    expect(stderr.join("\n")).toContain(`the file is at schema ${latest + 1}, newer than this build's ${latest}`)
  })

  it("**fails it when this build may not, and says to upgrade**", async () => {
    const { answer, stderr } = await ahead(latest + 1)
    expect(answer.checks.schema).toBe(false)
    expect(answer.ok).toBe(false)
    expect(stderr.join("\n")).toContain("`chat upgrade`")
  })
})

describe("a file that is empty or is not a database", () => {
  it("answers for the empty file a store makes before its first migration", async () => {
    const env = envFor()
    writeFileSync(String(env.MESSAGING_STORE), "")

    expect((await call(["store", "info", "--json"], env)).answer).toMatchObject({ schema: { version: 0 }, rows: {} })
    const { answer, stdout } = await call(["store", "check", "--json"], env)
    expect(stdout).toHaveLength(1)
    expect(answer).toMatchObject({ opens: true, ok: false, checks: { schema: false }, search_indexes: {} })
  })

  it("**says a file that will not open does not open**, instead of failing", async () => {
    const env = envFor()
    writeFileSync(String(env.MESSAGING_STORE), "not a database, not even close".repeat(40))

    for (const command of ["info", "check"]) {
      const { code, stdout, answer } = await call(["store", command, "--json"], env)
      expect(code).toBe(0)
      expect(stdout).toHaveLength(1)
      expect(answer).toMatchObject({ exists: true, opens: false, error: expect.any(String) })
    }
  })
})

describe("store migrate", () => {
  it("normalizes the baseline file, saying so on stderr", async () => {
    const env = envFor()
    ;(await seeded(env, latest)).close()

    const { answer, stderr } = await call(["store", "migrate", "--json"], env)
    expect(answer).toEqual({
      path: env.MESSAGING_STORE,
      exists: true,
      from: latest,
      to: latest,
      normalized: 2,
      indexed: 0,
      terms: 4,
      stemmed: 2,
      notes_indexed: 0,
    })
    expect(stderr.join("\n")).toContain("2 of 2 normalized")

    const database = await openCache(String(env.MESSAGING_STORE))
    expect(database.prepare("SELECT normalized_text FROM messages ORDER BY id").all()).toEqual([
      { normalized_text: "hola, ¿que tal?" },
      { normalized_text: "елка" },
    ])
    database.close()
    expect((await call(["store", "migrate", "--json"], env)).answer).toMatchObject({ from: latest, normalized: 0 })
  })
})

describe("the word index", () => {
  const words = async (env: NodeJS.ProcessEnv, word: string) => {
    const database = await openCache(String(env.MESSAGING_STORE))
    try {
      return database
        .prepare("SELECT rowid FROM message_words WHERE message_words MATCH ?")
        .all(`normalized_text: ${word}`).length
    } finally {
      database.close()
    }
  }

  it("**`store rebuild` rebuilds it and its vocabulary** from the stored messages", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    await call(["store", "migrate", "--json"], env)

    const { answer } = await call(["store", "rebuild", "--json"], env)

    expect(answer).toEqual({
      path: env.MESSAGING_STORE,
      exists: true,
      normalized: 0,
      indexed: 2,
      terms: 4,
      file_texts: 0,
      stemmed: 2,
      notes_indexed: 0,
      involvements: 0,
    })
    expect(await words(env, "hola")).toBe(1)
    const { answer: info } = await call(["store", "info", "--json"], env)
    expect(info.word_index).toMatchObject({ watermark: 2, filled_through: 2, ready: true, pending_normalization: 0 })
  })

  it("**`store check` checks it, and says how far a large file's fill has come**", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec("UPDATE search_index_state SET watermark = 10, filled_through = 1")
    database.close()

    const { answer, body } = await call(["store", "check", "--json"], env)

    expect(answer.search_indexes.message_words).toBe("ok")
    expect(answer.search_indexes.attachment_words).toBe("ok")
    expect(answer.word_index).toMatchObject({ watermark: 10, filled_through: 1, ready: false })
    expect(body.next).toContainEqual(expect.objectContaining({ step: "store.migrate" }))
  })

  it("**`store check` says the typo vocabulary is behind the messages**, and `store migrate` finishes it", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    await call(["store", "migrate", "--json"], env)
    const database = await openCache(String(env.MESSAGING_STORE))
    database.exec("UPDATE search_index_state SET terms_through = 1 WHERE name = 'message_words'")
    database.close()

    const { answer, body } = await call(["store", "check", "--json"], env)
    expect(answer.word_index).toMatchObject({ ready: true, terms_through: 1, terms_ready: false })
    expect(body.next).toContainEqual(expect.objectContaining({ step: "store.migrate" }))

    await call(["store", "migrate", "--json"], env)
    expect((await call(["store", "check", "--json"], env)).answer.word_index).toMatchObject({ terms_ready: true })
  })

  it("`store rebuild` refuses a file requiring a newer build", async () => {
    const env = envFor()
    const database = await seeded(env)
    migrate(database, {
      migrations: [...MIGRATIONS, { version: latest + 1, minCompatible: latest + 1, statements: [] }],
    })
    database.close()
    const { code, stderr } = await call(["store", "rebuild", "--json"], env)
    expect(code).not.toBe(0)
    expect(stderr.join("\n")).toContain("upgrade this tool")
  })
})

const messagesIn = async (path: string) => {
  const database = await openCache(path)
  try {
    return Number(database.prepare("SELECT count(*) AS n FROM messages").get()?.n)
  } finally {
    database.close()
  }
}

const backedUp = async () => {
  const env = envFor()
  ;(await seeded(env)).close()
  const file = join(dirname(String(env.MESSAGING_STORE)), "copy.db")
  const { answer } = await call(["store", "backup", file, "--json"], env)
  return { env, file, answer }
}

describe("store backup", () => {
  it("**writes a copy that opens with the same counts, readable by the owner alone**", async () => {
    const { file, answer } = await backedUp()

    expect(answer).toMatchObject({ path: file, schema: latest, rows: { chats: 2, messages: 2 } })
    expect(await messagesIn(file)).toBe(2)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it("never overwrites a file", async () => {
    const { env, file } = await backedUp()
    const { code, stdout } = await call(["store", "backup", file, "--json"], env)
    expect(code).not.toBe(0)
    expect(stdout).toEqual([])
  })
})

describe("store restore", () => {
  it("**puts the backup in place and keeps the store it replaced**", async () => {
    const { env, file } = await backedUp()
    const database = await openCache(String(env.MESSAGING_STORE))
    database.exec("DELETE FROM messages WHERE id = 1")
    database.close()

    const { answer } = await call(["store", "restore", file, "--json"], env)
    expect(answer).toMatchObject({ path: env.MESSAGING_STORE, restored_from: file, schema: latest })
    expect(await messagesIn(String(env.MESSAGING_STORE))).toBe(2)
    expect(await messagesIn(answer.kept_at)).toBe(1)
    expect(existsSync(file)).toBe(true)
  })

  it("**refuses while another connection is writing**, and leaves the store where it was", async () => {
    const { env, file } = await backedUp()
    const writer = await openCache(String(env.MESSAGING_STORE))
    writer.exec("BEGIN IMMEDIATE")
    try {
      const { code, stderr } = await call(["store", "restore", file, "--json"], env, 10)
      expect(code).not.toBe(0)
      expect(stderr.join("\n")).toContain("a write to the store is under way")
    } finally {
      writer.exec("ROLLBACK")
      writer.close()
    }
    expect(readdirSync(dirname(String(env.MESSAGING_STORE))).some((name) => name.includes("before-restore"))).toBe(
      false,
    )
  })

  it.skipIf(process.platform !== "linux")(
    "**refuses while another process has the store open**, whichever CLI it is",
    async () => {
      const { env, file } = await backedUp()
      const path = String(env.MESSAGING_STORE)
      const holder = spawn(
        process.execPath,
        ["-e", `require("node:fs").openSync(${JSON.stringify(path)}, "r"); setInterval(() => {}, 1000)`],
        { stdio: "ignore" },
      )
      try {
        await expect.poll(() => holdersOf([realpathSync(path)])).toContain(holder.pid)
        const { code, stderr } = await call(["store", "restore", file, "--json"], env)
        expect(code).not.toBe(0)
        expect(stderr.join("\n")).toContain(`the store is open in process ${holder.pid}`)
      } finally {
        holder.kill()
      }
    },
  )

  it("refuses while this CLI's serve runs, before that serve has opened the store", async () => {
    const { env, file } = await backedUp()
    const serve = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    try {
      const lock = lockPath(app, "default", env)
      mkdirSync(dirname(lock), { recursive: true })
      writeFileSync(lock, JSON.stringify({ pid: serve.pid, startedAt: new Date().toISOString() }))

      const { code, stderr } = await call(["store", "restore", file, "--json"], env)
      expect(code).not.toBe(0)
      expect(stderr.join("\n")).toContain("chat serve is running for default — `chat default server stop` first")
    } finally {
      serve.kill()
    }
  })

  it("refuses a backup a newer version wrote, with the upgrade message", async () => {
    const { env, file } = await backedUp()
    const database = await openCache(file)
    migrate(database, {
      migrations: [...MIGRATIONS, { version: latest + 1, minCompatible: latest + 1, statements: [] }],
    })
    database.close()

    const { code, stderr } = await call(["store", "restore", file, "--json"], env)
    expect(code).not.toBe(0)
    expect(stderr.join("\n")).toContain("upgrade this tool")
  })
})

describe("store reset", () => {
  it("**backs the store up beside it, then starts an empty one** — never unasked, never under a writer", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    const path = String(env.MESSAGING_STORE)

    const unasked = await call(["store", "reset", "--json"], env)
    expect(unasked.code).not.toBe(0)
    expect(unasked.stderr.join("\n")).toContain("add --yes")

    const writer = await openCache(path)
    writer.exec("BEGIN IMMEDIATE")
    try {
      const held = await call(["store", "reset", "--yes", "--json"], env, 10)
      expect(held.code).not.toBe(0)
      expect(held.stderr.join("\n")).toContain("a write to the store is under way")
    } finally {
      writer.exec("ROLLBACK")
      writer.close()
    }
    expect(readdirSync(dirname(path)).some((name) => name.includes(".backup-"))).toBe(false)
    expect(await messagesIn(path)).toBe(2)

    const { code, answer, stderr } = await call(["store", "reset", "--yes", "--json"], env)
    expect(code).toBe(0)
    expect(answer).toMatchObject({ path, reset: true, schema: latest, backed_up: { rows: { messages: 2 } } })
    expect(answer.backup).toMatch(/m\.db\.backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/)
    expect(stderr.join("\n")).toContain(`backed the store up to ${answer.backup}`)
    expect(await messagesIn(answer.backup)).toBe(2)
    expect(statSync(answer.backup).mode & 0o777).toBe(0o600)
    expect(await messagesIn(path)).toBe(0)
  })

  it("**--no-backup** resets without a copy beside the store", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    const path = String(env.MESSAGING_STORE)

    const { code, answer, stderr } = await call(["store", "reset", "--no-backup", "--yes", "--json"], env)
    expect(code).toBe(0)
    expect(answer).toMatchObject({ path, reset: true, schema: latest, backup: null, backed_up: null })
    expect(stderr.join("\n")).toContain("there is no backup")
    expect(readdirSync(dirname(path)).some((name) => name.includes(".backup-"))).toBe(false)
    expect(await messagesIn(path)).toBe(0)
  })

  it("**--dry-run lists every table it would empty, with its rows**, and deletes nothing", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    const path = String(env.MESSAGING_STORE)

    const { code, answer } = await call(["store", "reset", "--no-backup", "--dry-run", "--json"], env)
    expect(code).toBe(0)
    expect(answer).toMatchObject({ path, reset: false, dry_run: true, schema: latest, backup_first: false })
    expect(answer.files).toContain(path)
    expect(answer.bytes).toBeGreaterThan(0)
    const tables = Object.fromEntries(
      answer.tables.map((table: { name: string; rows: number }) => [table.name, table.rows]),
    )
    expect(tables).toMatchObject({ accounts: 1, chats: 2, messages: 2 })
    expect(Object.keys(tables).some((name) => name.startsWith("messages_fts") || name === "schema_migrations")).toBe(
      false,
    )
    expect(await messagesIn(path)).toBe(2)
    expect(readdirSync(dirname(path)).some((name) => name.includes(".backup-"))).toBe(false)
  })

  it("**--dry-run answers while a write is under way**, which the real reset would wait out", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    const writer = await openCache(String(env.MESSAGING_STORE))
    writer.exec("BEGIN IMMEDIATE")
    try {
      const { code, answer } = await call(["store", "reset", "--dry-run", "--json"], env, 10)
      expect(code).toBe(0)
      expect(answer.backup_first).toBe(true)
      if (process.platform === "linux") expect(answer.in_use).toBe(false)
    } finally {
      writer.exec("ROLLBACK")
      writer.close()
    }
  })

  it("**a migration that fails names `store reset`**, keeping SQLite's own words", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec("DELETE FROM schema_migrations")
    database.close()

    const { code, stderr } = await call(["store", "migrate", "--json"], env)
    expect(code).not.toBe(0)
    expect(stderr.join("\n")).toContain("already exists")
    expect(stderr.join("\n")).toContain("`chat store reset` takes a backup of it first")
  })
})

describe("the stems", () => {
  it("**`config set search_stemmers.*` is store-wide**: stems wait for `store rebuild`, which rebuilds them", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    await call(["store", "migrate", "--json"], env)

    const set = await call(["config", "set", "search_stemmers.latin", "english", "--json"], env)
    expect(set.answer).toEqual({
      store: env.MESSAGING_STORE,
      scope: "store",
      setting: "search_stemmers.latin",
      value: "english",
    })
    expect(set.stderr.join("\n")).toContain("store-wide")
    expect((await call(["store", "info", "--json"], env)).answer.stem_index).toMatchObject({
      ready: false,
      cause: "stemmer_changed",
      wanted: "snowball-3.1.1 cyrillic=russian latin=english",
    })

    expect((await call(["store", "rebuild", "--json"], env)).answer).toMatchObject({ stemmed: 2 })
    expect((await call(["store", "info", "--json"], env)).answer.stem_index).toMatchObject({
      ready: true,
      built: "snowball-3.1.1 cyrillic=russian latin=english",
    })
    const shown = (await call(["config", "show", "--json"], env)).answer.store_settings
    expect(shown).toContainEqual({ setting: "search_stemmers.latin", value: "english", from: "store", scope: "store" })
  })

  it("**`config set phone_countries` is store-wide** and points at the rebuild that reads numbers again", async () => {
    const env = envFor()
    ;(await seeded(env)).close()

    const set = await call(["config", "set", "phone_countries", "ES, ru", "--json"], env)
    expect(set.answer).toEqual({
      store: env.MESSAGING_STORE,
      scope: "store",
      setting: "phone_countries",
      value: "es,ru",
    })
    expect(set.body.next).toContainEqual(expect.objectContaining({ step: "mentions.rebuild", args: { kind: "phone" } }))
    const shown = (await call(["config", "show", "--json"], env)).answer.store_settings
    expect(shown).toContainEqual({ setting: "phone_countries", value: "es,ru", from: "store", scope: "store" })

    const refused = await call(["config", "set", "phone_countries", "es,xx", "--json"], env)
    expect(refused.code).not.toBe(0)
    expect(refused.stderr.join("\n")).toContain("not xx")
  })

  it("**`config set task_categories.<name>` edits the shared config file** every tool reads, and unset resets", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    const file = join(dirname(env.MESSAGING_STORE as string), "config.json")
    writeFileSync(file, JSON.stringify({ theme: "dark" }))
    const section = () => JSON.parse(readFileSync(file, "utf8")).task_categories
    const listed = async () => {
      const store = await openStore({ env })
      try {
        return (await store.tasks.categories()).map(({ name }) => name)
      } finally {
        await store.close()
      }
    }

    const set = await call(
      [
        "config",
        "set",
        "task_categories.garden",
        "plants and seeds | seedling, compost, рассада, es:semilla",
        "--json",
      ],
      env,
    )
    expect(set.answer).toEqual({
      store: env.MESSAGING_STORE,
      file,
      scope: "shared",
      setting: "task_categories.garden",
      value: "plants and seeds | en:seedling, en:compost, ru:рассада, es:semilla",
    })
    expect((await listed()).slice(-2)).toEqual(["garden", "other"])
    const shown = (await call(["config", "show", "--json"], env)).answer.store_settings
    expect(shown).toContainEqual(expect.objectContaining({ setting: "task_categories.garden", from: file }))
    expect(shown).toContainEqual(expect.objectContaining({ setting: "task_categories.money", from: "default" }))

    await call(["config", "unset", "task_categories.personal", "--json"], env)
    expect(await listed()).not.toContain("personal")
    expect(section()).toEqual({ garden: expect.stringContaining("plants and seeds"), personal: null })
    expect(JSON.parse(readFileSync(file, "utf8")).theme).toBe("dark")

    writeFileSync(file, JSON.stringify({ task_categories: { ...section(), boats: "sailing | yacht" } }))
    expect((await listed()).slice(-3)).toEqual(["garden", "boats", "other"])
    writeFileSync(file, "{ broken")
    const broken = await call(["config", "set", "task_categories.kites", "flying | kite", "--json"], env)
    expect(broken.code).not.toBe(0)
    expect(broken.stderr.join("\n")).toContain(file)
    writeFileSync(file, JSON.stringify({ task_categories: { personal: null } }))
    const fallback = await call(["config", "unset", "task_categories.other", "--json"], env)
    expect([fallback.code, fallback.stderr.join("\n")]).toEqual([2, expect.stringContaining("other stays")])
    expect((await call(["config", "set", "task_categories.Bad Name", "x", "--json"], env)).code).toBe(2)

    await call(["config", "unset", "task_categories", "--json"], env)
    expect(await listed()).toEqual(DEFAULT_TASK_CATEGORIES.map(({ name }) => name))
    expect(section()).toBeUndefined()
  })

  it("**moves a list an older build saved in the store into the shared file** on the next config write", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    const store = await openStore({ env })
    await store.tasks.saveCategories(DEFAULT_TASK_CATEGORIES.filter(({ name }) => name !== "food"))
    await store.close()
    const file = join(dirname(env.MESSAGING_STORE as string), "config.json")

    await call(["config", "set", "task_categories.boats", "sailing | yacht", "--json"], env)
    expect(JSON.parse(readFileSync(file, "utf8")).task_categories).toEqual({ food: null, boats: "sailing | en:yacht" })
    const after = await openStore({ env })
    try {
      expect(await after.tasks.savedCategories()).toBeUndefined()
      expect((await after.tasks.categories()).map(({ name }) => name)).not.toContain("food")
    } finally {
      await after.close()
    }
  })

  it("**`config set task_agent_close` and `task_agent_close_min` decide agent closes store-wide**, unset resets", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    const shown = async () =>
      (await call(["config", "show", "--json"], env)).answer.store_settings.filter(({ setting }: { setting: string }) =>
        setting.startsWith("task_agent_close"),
      )
    expect(await shown()).toEqual([
      { setting: "task_agent_close", value: "on", from: "default", scope: "store" },
      { setting: "task_agent_close_min", value: 0.8, from: "default", scope: "store" },
    ])

    expect((await call(["config", "set", "task_agent_close", "off", "--json"], env)).answer).toMatchObject({
      setting: "task_agent_close",
      value: "off",
    })
    expect((await call(["config", "set", "task_agent_close_min", "0.95", "--json"], env)).answer).toMatchObject({
      value: 0.95,
    })
    expect(await shown()).toEqual([
      { setting: "task_agent_close", value: "off", from: "store", scope: "store" },
      { setting: "task_agent_close_min", value: 0.95, from: "store", scope: "store" },
    ])
    expect((await call(["config", "set", "task_agent_close_min", "1.5", "--json"], env)).code).toBe(2)
    expect((await call(["config", "set", "task_agent_close", "maybe", "--json"], env)).code).toBe(2)

    await call(["config", "unset", "task_agent_close", "--json"], env)
    await call(["config", "unset", "task_agent_close_min", "--json"], env)
    expect((await shown()).map(({ from }: { from: string }) => from)).toEqual(["default", "default"])
  })

  it("**refuses to change the store-wide setting from a process locked to one profile**", async () => {
    const env = { ...envFor(), CHAT_PROFILE_LOCK: "work" }
    const { code, stderr } = await call(["config", "set", "search_stemmers.latin", "english", "--json"], env)
    expect(code).not.toBe(0)
    expect(stderr.join("\n")).toContain("changes every profile")
  })

  it("**saves an account group store-wide, shows it, and removes it**", async () => {
    const env = envFor()
    const set = await call(
      ["config", "set", "account_groups.work", "telegram:102, email:me@work.example", "--json"],
      env,
    )
    expect(set.answer).toMatchObject({
      setting: "account_groups.work",
      value: ["telegram:102", "email:me@work.example"],
    })
    const shown = (await call(["config", "show", "--json"], env)).answer.store_settings
    expect(shown).toContainEqual({
      setting: "account_groups.work",
      value: "telegram:102,email:me@work.example",
      from: "store",
      scope: "store",
    })
    await call(["config", "unset", "account_groups.work", "--json"], env)
    const after = (await call(["config", "show", "--json"], env)).answer.store_settings
    expect(after.map(({ setting }: { setting: string }) => setting)).not.toContain("account_groups.work")
    const nested = await call(["config", "set", "account_groups.all-work", "group:work", "--json"], env)
    expect(nested.code).not.toBe(0)
    expect(nested.stderr.join("\n")).toContain("not other groups")
  })

  it("**refuses the camelCase store setting names** as unknown settings", async () => {
    const env = envFor()
    for (const typed of ["searchStemmers.latin", "accountGroups.work"]) {
      const { code, stderr } = await call(["work", "config", "set", typed, "english", "--json"], env)
      expect(code).toBe(2)
      expect(JSON.parse(stderr.join("\n")).error.message).toContain(`no setting called "${typed}"`)
    }
  })

  it("**refuses a stemmer of the other script**, naming the allowed ones", async () => {
    const env = envFor()
    const { code, stderr } = await call(["config", "set", "search_stemmers.cyrillic", "english", "--json"], env)
    expect(code).not.toBe(0)
    expect(stderr.join("\n")).toContain("russian, none")
  })

  it("**`store migrate` rebuilds stems built by other choices**", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    await call(["store", "migrate", "--json"], env)
    await call(["config", "set", "search_stemmers.cyrillic", "none", "--json"], env)

    const { answer, stderr } = await call(["store", "migrate", "--json"], env)
    expect(answer).toMatchObject({ stemmed: 2 })
    expect(stderr.join("\n")).toContain("rebuilding them with snowball-3.1.1 cyrillic=none latin=english,spanish")
  })
})

describe("store repair and store copies delete", () => {
  it("repairs nothing in a healthy store, and deletes only a repair copy, by name", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec("CREATE TABLE chats__repair_0123abcd (pk integer)")
    database.close()

    const dry = await call(["store", "repair", "--dry-run", "--json"], env)
    const refused = await call(["store", "copies", "delete", "chats", "--json"], env)
    const deleted = await call(["store", "copies", "delete", "chats__repair_0123abcd", "--json"], env)

    expect(dry.answer).toMatchObject({
      dry_run: true,
      repaired: [],
      mismatches: [],
      copies: [{ name: "chats__repair_0123abcd" }],
    })
    expect(refused.code).not.toBe(0)
    expect(deleted.answer).toMatchObject({ deleted: { name: "chats__repair_0123abcd", rows: 0 } })
    expect((await call(["store", "info", "--json"], env)).answer.rows.chats).toBe(2)
  })
})
