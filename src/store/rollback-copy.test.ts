import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { CacheDatabase } from "./driver.js"
import { MIGRATIONS, type Migration, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { generatedMigrations, MANIFEST } from "./sqlite/manifest.js"
import { isDerivedTable, pruneRollbackCopies, rollBack } from "./sqlite/rollback-copy.js"
import { openStore } from "./store.js"

const latest = MIGRATIONS.at(-1)?.version ?? 0
const HOUR = 60 * 60 * 1000
const T = Date.UTC(2026, 10, 6, 12)
const plenty = () => 1e12
const upTo = (version: number, migrations = MIGRATIONS) => migrations.filter((m) => m.version <= version)
const COPY_TABLES = ["rollback_meta", "rollback_schema", "search_index_state", "store_settings"]

/** What a jump from `from` copies: the tables of every migration in it that raises min_compatible. */
const namedAfter = (from: number) => {
  const named = new Set<string>()
  let floor = MIGRATIONS.find((m) => m.version === from)?.minCompatible ?? 0
  for (const m of MIGRATIONS.filter((m) => m.version > from && m.minCompatible > floor)) {
    floor = m.minCompatible
    for (const table of m.tables ?? []) named.add(table)
  }
  return named
}

const fileAt = async (version: number) => {
  const dir = mkdtempSync(join(tmpdir(), "rollback-copy-"))
  const path = join(dir, "wirecat.db")
  const database = await openCache(path)
  migrate(database, { migrations: upTo(version), now: () => 1 })
  seed(database, version)
  return { dir, path, backups: join(dir, "backups"), database }
}

const seed = (database: CacheDatabase, version: number) => {
  const [tags, claims] = version < 30 ? ["tags", "auto_tag_claims"] : ["canonical_tags", "canonical_auto_tag_claims"]
  database.exec(`
    INSERT INTO accounts (id, provider, external_id, name, created_at, updated_at)
      VALUES (1, 'chat', '500', 'Chat', 0, 0), (2, 'folder', 'notes', 'google-drive:me@example.com', 0, 0);
    INSERT INTO chats (id, account_id, external_id, kind, title, created_at, updated_at)
      VALUES (1, 1, '7', 'group', 'Book club', 0, 0), (2, 1, '8', 'private', 'Ana', 0, 0);
    INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, source, created_at, updated_at)
      VALUES (1, 1, '1', 1, 'Hola, ¿qué tal?', 'fetch', 0, 0), (2, 1, '2', 2, 'Ёлка', 'fetch', 0, 0);
    INSERT INTO identities (id, provider, external_id, created_at, updated_at)
      VALUES (1, 'email', 'Ana@Example.com', 0, 0);
    INSERT INTO ${tags} (id, name, kind, created_at, updated_at) VALUES (1, 'books', 'tag', 0, 0), (2, 'family', 'tag', 0, 0);
    INSERT INTO ${claims} (chat_id, tag_id, algorithm, score, fields, created_at, updated_at)
      VALUES (1, 1, 'words', 0.9, '[]', 0, 0);
    INSERT INTO taggings (tag_id, taggable_type, taggable_id, source, created_at, updated_at)
      VALUES (1, 'chat', 1, 'manual', 0, 0);
  `)
}

const schemaOf = (database: CacheDatabase) =>
  database
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
    )
    .all()

const versionOf = (database: CacheDatabase) =>
  Number(database.prepare("SELECT max(version) AS v FROM schema_migrations").get()?.v)

/** Every row of every base table, the way a rollback must give them back. */
const baseRows = (database: CacheDatabase) =>
  Object.fromEntries(
    database
      .prepare(
        "SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      )
      .all()
      .map((row) => ({ name: String(row.name), rowid: Number(row.wr) === 0 }))
      .filter(({ name }) => !isDerivedTable(name) && name !== "schema_migrations")
      .map(({ name, rowid }) => [
        name,
        database.prepare(`SELECT ${rowid ? "rowid AS r, " : ""}* FROM "${name}" ORDER BY 1`).all(),
      ]),
  )

const copiesIn = (backups: string) =>
  existsSync(backups) ? readdirSync(backups).filter((name) => name.includes("-rollback-schema-")) : []

const pointers = (database: CacheDatabase) =>
  database.prepare("SELECT key FROM store_settings WHERE key LIKE 'rollback\\_copy:%' ESCAPE '\\'").all()

const tablesOfCopy = async (path: string) => {
  const copy = await openCache(path)
  try {
    const names = copy
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name))
    const rows = Object.fromEntries(
      names.map((name) => [name, Number(copy.prepare(`SELECT count(*) AS n FROM "${name}"`).get()?.n)]),
    )
    return { names, rows }
  } finally {
    copy.close()
  }
}

/** A breaking 54 that changes `chats`, then an additive 55 that extends `messages`, which 54 does not name. */
const future: Migration[] = [
  ...MIGRATIONS,
  {
    version: latest + 1,
    minCompatible: latest + 1,
    // A title change also writes chat_revisions, by trigger.
    tables: ["chats", "chat_revisions"],
    statements: [
      "ALTER TABLE chats ADD folder text",
      "UPDATE chats SET title = upper(title), folder = 'inbox'",
      "CREATE TABLE chat_folders (id integer PRIMARY KEY, name text NOT NULL)",
    ],
  },
  {
    version: latest + 2,
    minCompatible: latest + 1,
    statements: [
      "ALTER TABLE messages ADD extra text",
      "CREATE INDEX messages_by_extra ON messages (extra)",
      "CREATE TABLE extras (id integer PRIMARY KEY)",
    ],
  },
]

describe("a migration that raises min_compatible", () => {
  it("**names the base tables it changes**, or the manifest refuses it", () => {
    const [initial, second] = MANIFEST
    const raising = [initial, { ...second, minCompatible: 2 }] as typeof MANIFEST
    expect(() => generatedMigrations(raising)).toThrow(/raises minCompatible, so it names the base tables/)
    expect(() =>
      generatedMigrations([initial, { ...second, minCompatible: 2, tables: [] }] as typeof MANIFEST),
    ).not.toThrow()
    expect(() =>
      generatedMigrations([initial, { ...second, minCompatible: 2, tables: ["messages_fts"] }] as typeof MANIFEST),
    ).toThrow(/derived tables \(messages_fts\)/)
    for (const [index, migration] of MIGRATIONS.entries()) {
      const before = MIGRATIONS[index - 1]
      if (before && migration.minCompatible > before.minCompatible)
        expect(migration.tables, `${migration.version}`).toBeDefined()
    }
  })

  it.each(
    MIGRATIONS.filter((m, i) => i > 0 && m.minCompatible > (MIGRATIONS[i - 1]?.minCompatible ?? 0)).map(
      (m) => m.version,
    ),
  )("**%i names every base table whose columns it changes or that it removes**", async (version) => {
    const database = await openCache(":memory:")
    try {
      migrate(database, { migrations: upTo(version - 1) })
      const columns = () =>
        new Map(
          database
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
            .all()
            .map((row) => String(row.name))
            .map((name) => [
              name,
              JSON.stringify(database.prepare("SELECT name, type FROM pragma_table_info(?)").all(name)),
            ]),
        )
      const before = columns()
      migrate(database, { migrations: upTo(version) })
      const after = columns()
      const changed = [...before].filter(([name, shape]) => after.get(name) !== shape && !isDerivedTable(name))
      const named = MIGRATIONS.find((m) => m.version === version)?.tables ?? []
      for (const [name] of changed) expect(named, `version ${version} changes ${name}`).toContain(name)
    } finally {
      database.close()
    }
  })
})

describe("the rollback copy", () => {
  it.each([30, 31, 32, 34])(
    "**before store version %i: only the named tables, and a rollback the older tool opens again**",
    async (breaking) => {
      const from = breaking - 1
      const { path, backups, database } = await fileAt(from)
      try {
        const schema = schemaOf(database)
        const rows = baseRows(database)
        const named = [...namedAfter(from)].filter((table) => table in rows)

        migrate(database, { now: () => T, rollback: { store: path, freeBytes: plenty } })
        expect(versionOf(database)).toBe(latest)
        const [copy] = copiesIn(backups)
        expect(copy).toMatch(new RegExp(`^wirecat-rollback-schema-${from}-`))
        const copied = await tablesOfCopy(join(backups, String(copy)))
        expect(copied.names.sort()).toEqual([...new Set([...COPY_TABLES, ...named])].sort())
        for (const table of named) expect(copied.rows[table], table).toBe((rows[table] ?? []).length)
        expect(pointers(database)).toHaveLength(1)
        expect(() => migrate(database, { migrations: upTo(from) })).toThrow(/written by a newer version/)

        const rolled = rollBack(database, join(backups, String(copy)))
        expect(rolled).toMatchObject({ from, was: latest, foreignKeyViolations: 0 })
        expect(schemaOf(database)).toEqual(schema)
        expect(baseRows(database)).toEqual(rows)
        expect(versionOf(database)).toBe(from)
        expect(pointers(database)).toHaveLength(0)
        expect(database.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok")
        database.exec("INSERT INTO messages_fts (messages_fts) VALUES ('integrity-check')")

        expect(() => migrate(database, { migrations: upTo(from) })).not.toThrow()
        migrate(database, { now: () => T + HOUR, rollback: { store: path, freeBytes: plenty } })
        expect(versionOf(database)).toBe(latest)
        expect(database.prepare("SELECT name FROM canonical_tags ORDER BY id").all()).toEqual([
          { name: "books" },
          { name: "family" },
        ])
      } finally {
        database.close()
      }
    },
  )

  it("**a future breaking migration**: copy, rollback, the older build opens it, and it migrates again", async () => {
    const { path, backups, database } = await fileAt(latest)
    try {
      const schema = schemaOf(database)
      const rows = baseRows(database)

      migrate(database, { migrations: future, now: () => T, rollback: { store: path, freeBytes: plenty } })
      expect(database.prepare("SELECT title, folder FROM chats ORDER BY id").all()).toEqual([
        { title: "BOOK CLUB", folder: "inbox" },
        { title: "ANA", folder: "inbox" },
      ])
      const [copy] = copiesIn(backups)
      const copied = await tablesOfCopy(join(backups, String(copy)))
      expect(copied.names.sort()).toEqual([...COPY_TABLES, "chat_revisions", "chats"].sort())
      expect(copied.rows.chats).toBe(2)
      expect(() => migrate(database, { migrations: MIGRATIONS })).toThrow(/written by a newer version/)

      const rolled = rollBack(database, join(backups, String(copy)))
      expect(rolled).toMatchObject({ from: latest, was: latest + 2, rebuilt: ["messages"] })
      expect(rolled.restored).toContainEqual({ table: "chats", rows: 2 })
      expect(schemaOf(database)).toEqual(schema)
      expect(baseRows(database)).toEqual(rows)
      database.exec("INSERT INTO messages_fts (messages_fts) VALUES ('integrity-check')")

      expect(() => migrate(database, { migrations: MIGRATIONS })).not.toThrow()
      expect(versionOf(database)).toBe(latest)
      migrate(database, { migrations: future, now: () => T + HOUR })
      expect(versionOf(database)).toBe(latest + 2)
    } finally {
      database.close()
    }
  })

  it("**is skipped with a warning when the disk has no room**, and the migration still runs", async () => {
    const { path, backups, database } = await fileAt(latest)
    try {
      const warnings: string[] = []
      migrate(database, {
        migrations: future,
        now: () => T,
        rollback: { store: path, freeBytes: () => 1024, warn: (line) => warnings.push(line) },
      })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("not enough free disk space for a rollback copy")
      expect(warnings[0]).toContain("pulled again from the sources")
      expect(copiesIn(backups)).toEqual([])
      expect(versionOf(database)).toBe(latest + 2)
    } finally {
      database.close()
    }
  })

  it("**a failed migration leaves the store as it was and the copy whole**, and cleanup keeps it", async () => {
    const { path, backups, database } = await fileAt(latest)
    try {
      const schema = schemaOf(database)
      const rows = baseRows(database)
      const failing: Migration[] = [
        ...MIGRATIONS,
        {
          version: latest + 1,
          minCompatible: latest + 1,
          tables: ["chats"],
          statements: ["ALTER TABLE chats ADD folder text", "UPDATE no_such_table SET x = 1"],
        },
      ]
      expect(() =>
        migrate(database, { migrations: failing, now: () => T, rollback: { store: path, freeBytes: plenty } }),
      ).toThrow(/could not be brought up/)
      expect(schemaOf(database)).toEqual(schema)
      expect(baseRows(database)).toEqual(rows)
      expect(pointers(database)).toHaveLength(0)
      const [copy] = copiesIn(backups)
      expect((await tablesOfCopy(join(backups, String(copy)))).rows.chats).toBe(2)

      pruneRollbackCopies(database, T + 48 * HOUR)
      expect(copiesIn(backups)).toEqual([copy])
    } finally {
      database.close()
    }
  })

  it("**is deleted the day after a migration that succeeded**, and nothing else in backups/", async () => {
    const { path, backups, database } = await fileAt(latest)
    try {
      mkdirSync(backups, { recursive: true })
      writeFileSync(join(backups, "last.json"), "{}")
      writeFileSync(join(backups, "wirecat-rollback-schema-1-unrecorded.db"), "")
      migrate(database, { migrations: future, now: () => T, rollback: { store: path, freeBytes: plenty } })
      const [recorded] = copiesIn(backups).filter((name) => !name.includes("unrecorded"))

      pruneRollbackCopies(database, T + 23 * HOUR)
      expect(copiesIn(backups)).toContain(recorded)
      pruneRollbackCopies(database, T + 25 * HOUR)
      expect(readdirSync(backups).sort()).toEqual(["last.json", "wirecat-rollback-schema-1-unrecorded.db"])
      expect(pointers(database)).toHaveLength(0)
    } finally {
      database.close()
    }
  })

  it("**is taken and pruned by an ordinary open**", async () => {
    const { path, backups, database } = await fileAt(33)
    database.close()
    const warnings: string[] = []
    const store = await openStore({ path, now: () => T, warn: (line) => warnings.push(line) })
    await store.close()
    const [copy] = copiesIn(backups)
    expect(copy).toMatch(/^wirecat-rollback-schema-33-/)
    expect((await tablesOfCopy(join(backups, String(copy)))).names.sort()).toEqual(
      [...new Set([...COPY_TABLES, ...namedAfter(33)])].sort(),
    )

    await (await openStore({ path, now: () => T + 25 * HOUR, warn: (line) => warnings.push(line) })).close()
    expect(copiesIn(backups)).toEqual([])
  })
})
