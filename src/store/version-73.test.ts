import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { CacheDatabase } from "./driver.js"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { MANIFEST } from "./sqlite/manifest.js"
import { rollBack } from "./sqlite/rollback-copy.js"

const upTo = (version: number) => MIGRATIONS.filter((migration) => migration.version <= version)
const V73 = MANIFEST.find(({ version }) => version === 73)?.tables ?? []
const plenty = () => 1e12

const fileAt72 = async () => {
  const dir = mkdtempSync(join(tmpdir(), "version-73-"))
  const path = join(dir, "wirecat.db")
  const database = await openCache(path)
  migrate(database, { migrations: upTo(72), now: () => 1 })
  database.exec(`
    INSERT INTO accounts (id, provider, external_id, name, created_at, updated_at) VALUES (1, 'chat', '500', 'Chat', 0, 0);
    INSERT INTO chats (id, account_id, external_id, kind, title, created_at, updated_at)
      VALUES (1, 1, '7', 'group', 'Book club', 0, 0);
    INSERT INTO messages (id, chat_id, account_id, external_id, sent_at, text, source, created_at, updated_at)
      VALUES (40, 1, 1, '1', 1, 'Hola, ¿qué tal?', 'fetch', 0, 0), (41, 1, 1, '2', 2, 'Ёлка', 'fetch', 0, 0);
    INSERT INTO persons (id, owner, created_at, updated_at) VALUES (2, 0, 0, 0), (3, 0, 0, 0), (5, 0, 0, 0);
    INSERT INTO organizations (id, kind, name, scope, created_at, updated_at)
      VALUES (10, 'company', 'Acme', 'work', 0, 0), (2766, 'company', 'Gone', 'work', 0, 0);
    INSERT INTO canonical_tags (id, name, kind, created_at, updated_at) VALUES (1, 'books', 'tag', 0, 0);
    INSERT INTO taggings (tag_id, taggable_type, taggable_id, source, created_at, updated_at)
      VALUES (1, 'message', 41, 'manual', 0, 0);
    INSERT INTO facts (type, statement, status, subject_type, subject_id, author_type, author_id, source, created_at, updated_at)
      VALUES ('fact', 'Gone is a client', 'accepted', 'organization', 2766, 'person', 1, 'owner', 0, 0);
    DELETE FROM organizations WHERE id = 2766;
    DELETE FROM persons WHERE id = 5;
    CREATE TABLE other_tool_items (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER REFERENCES persons(id), note TEXT);
    INSERT INTO other_tool_items (person_id, note) VALUES (2, 'kept'), (3, 'kept too');
    UPDATE sqlite_sequence SET seq = 500 WHERE name = 'other_tool_items';
    CREATE TRIGGER other_tool_person_ad AFTER DELETE ON persons BEGIN
      DELETE FROM other_tool_items WHERE person_id = old.id;
    END;
  `)
  return { dir, path, database }
}

const objects = (database: CacheDatabase) =>
  database
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL")
    .all()
    .map((row) => ({ type: String(row.type), name: String(row.name), sql: String(row.sql) }))

const sequence = (database: CacheDatabase, table: string) =>
  Number(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table)?.seq)

const version = (database: CacheDatabase) =>
  database.prepare("SELECT version, min_compatible FROM schema_migrations ORDER BY version DESC LIMIT 1").get()

describe("store version 73", () => {
  it("**never hands an id out twice**: every base table counts on past the largest id the store knows", async () => {
    const { path, database } = await fileAt72()
    const before = objects(database)
    migrate(database, { now: () => 2, rollback: { store: path, freeBytes: plenty } })

    expect(version(database)).toEqual({ version: 73, min_compatible: 73 })
    const plain = database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE '%AUTOINCREMENT%'
         AND name IN (${V73.map(() => "?").join(", ")})`,
      )
      .all(...V73)
    expect(plain).toEqual([])
    expect(V73).toHaveLength(101)

    // A fact still names organization 2766, so its id stays taken; person 5 was freed unseen, so the margin covers it.
    expect(sequence(database, "organizations")).toBe(2766 + 1000)
    expect(sequence(database, "persons")).toBe(3 + 1000)
    expect(sequence(database, "messages")).toBe(41 + 1000)
    expect(sequence(database, "bots")).toBeGreaterThan(1000)
    expect(sequence(database, "deals")).toBe(1000)
    const person = database
      .prepare("INSERT INTO persons (owner, created_at, updated_at) VALUES (0, 3, 3) RETURNING id")
      .get()
    expect(person?.id).toBe(1004)
    database.prepare("DELETE FROM persons WHERE id = ?").run(1004)
    const again = database
      .prepare("INSERT INTO persons (owner, created_at, updated_at) VALUES (0, 4, 4) RETURNING id")
      .get()
    expect(again?.id).toBe(1005)

    const after = new Map(objects(database).map((object) => [object.name, object.sql]))
    for (const object of before) expect(after.get(object.name), object.name).toBe(object.sql)
    expect([...after.keys()].filter((name) => !before.some((object) => object.name === name))).toEqual([
      "taggings_by_taggable_type_taggable_id",
    ])
    expect(database.prepare("SELECT id, text FROM messages ORDER BY id").all()).toEqual([
      { id: 40, text: "Hola, ¿qué tal?" },
      { id: 41, text: "Ёлка" },
    ])
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
    expect(() => database.exec("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')")).not.toThrow()
    expect(Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys)).toBe(1)

    // Triggers came back: deleting the message drops its tagging.
    database.exec("DELETE FROM messages WHERE id = 41")
    expect(database.prepare("SELECT count(*) AS n FROM taggings").get()?.n).toBe(0)
    database.close()
  })

  it("leaves another tool's tables, rows, counters and triggers as they were", async () => {
    const { path, database } = await fileAt72()
    const sql = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'other_tool_items'").get()?.sql
    migrate(database, { now: () => 2, rollback: { store: path, freeBytes: plenty } })

    expect(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'other_tool_items'").get()?.sql).toBe(sql)
    expect(database.prepare("SELECT id, person_id, note FROM other_tool_items ORDER BY id").all()).toEqual([
      { id: 1, person_id: 2, note: "kept" },
      { id: 2, person_id: 3, note: "kept too" },
    ])
    expect(sequence(database, "other_tool_items")).toBe(500)
    database.exec("DELETE FROM persons WHERE id = 2")
    expect(database.prepare("SELECT count(*) AS n FROM other_tool_items").get()?.n).toBe(1)
    database.close()
  })

  it("is refused by a build that speaks 72", async () => {
    const { path, database } = await fileAt72()
    migrate(database, { now: () => 2, rollback: { store: path, freeBytes: plenty } })
    database.close()

    const old = await openCache(path)
    expect(() => migrate(old, { migrations: upTo(72), now: () => 3 })).toThrow(
      /written by a newer version \(schema 73, needs at least 73; this one speaks 72\)/,
    )
    old.close()
  })

  it("**refuses to migrate without a rollback copy**, unless the owner says so", async () => {
    const { dir, path, database } = await fileAt72()
    const warnings: string[] = []
    const short = { store: path, freeBytes: () => 1024, warn: (line: string) => warnings.push(line) }

    expect(() => migrate(database, { now: () => 2, rollback: short })).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "store.no-rollback-copy" }) }),
    )
    expect(version(database)).toEqual({ version: 72, min_compatible: 56 })
    expect(Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys)).toBe(1)

    migrate(database, { now: () => 2, rollback: { ...short, withoutCopy: true } })
    expect(version(database)).toEqual({ version: 73, min_compatible: 73 })
    expect(warnings).toEqual([expect.stringContaining("migrating without one")])
    database.close()
    expect(readdirSync(join(dir, "backups"))).toEqual([])
  })

  it("takes the rollback copy of every table it copies", async () => {
    const { dir, path, database } = await fileAt72()
    migrate(database, { now: () => 2, rollback: { store: path, freeBytes: plenty } })
    database.close()
    const [copy] = readdirSync(join(dir, "backups"))
    const saved = await openCache(join(dir, "backups", String(copy)))
    const tables = JSON.parse(
      String(saved.prepare("SELECT value FROM rollback_meta WHERE key = 'tables'").get()?.value),
    )
    expect(tables).toEqual(expect.arrayContaining(V73))
    expect(saved.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(2)
    saved.close()
  })

  it("**goes back to 72 from its rollback copy**, and up to 73 again", async () => {
    const { dir, path, database } = await fileAt72()
    const rows = database.prepare("SELECT id, text FROM messages ORDER BY id").all()
    migrate(database, { now: () => 2, rollback: { store: path, freeBytes: plenty } })
    database.exec(
      "INSERT INTO organizations (kind, name, scope, created_at, updated_at) VALUES ('company', 'New', 'work', 3, 3)",
    )
    const [copy] = readdirSync(join(dir, "backups"))

    const back = rollBack(database, join(dir, "backups", String(copy)))
    expect(back.foreignKeyViolations).toBe(0)
    expect(version(database)).toEqual({ version: 72, min_compatible: 56 })
    expect(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages'").get()?.sql).not.toContain(
      "AUTOINCREMENT",
    )
    expect(database.prepare("SELECT id, text FROM messages ORDER BY id").all()).toEqual(rows)
    expect(database.prepare("SELECT id FROM organizations ORDER BY id").all()).toEqual([{ id: 10 }])

    migrate(database, { now: () => 4, rollback: { store: path, freeBytes: plenty } })
    expect(version(database)).toEqual({ version: 73, min_compatible: 73 })
    // Organization 3767 was handed out before the rollback; it is not handed out again.
    expect(sequence(database, "organizations")).toBe(3767 + 1000)
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
    database.close()
  })

  it("keeps text that is not JSON as a JSON string, and says so", async () => {
    const { path, database } = await fileAt72()
    database.exec("UPDATE messages SET metadata = '{truncated' WHERE id = 40")
    const notice = migrate(database, { now: () => 2, rollback: { store: path, freeBytes: plenty } })

    expect(notice).toContain("messages.metadata held text that is not JSON in 1 row (40)")
    expect(database.prepare("SELECT metadata FROM messages WHERE id = 40").get()?.metadata).toBe('"{truncated"')
    expect(
      JSON.parse(
        String(database.prepare("SELECT value FROM store_settings WHERE key = 'migration:73:repaired'").get()?.value),
      ),
    ).toEqual([{ table: "messages", column: "metadata", rows: 1, ids: [40] }])
    expect(() => database.exec("UPDATE messages SET metadata = '{bad' WHERE id = 41")).toThrow(
      /CHECK constraint failed/,
    )
    database.close()
  })

  it("refuses rows a new rule cannot repair, naming them, and changes nothing", async () => {
    const { path, database } = await fileAt72()
    database.exec("UPDATE facts SET confirmed_by_type = 'person', confirmed_by_id = NULL")
    expect(() => migrate(database, { now: () => 2, rollback: { store: path, freeBytes: plenty } })).toThrow(
      /facts rows 1 break facts_confirmed_by_pair/,
    )
    expect(version(database)).toEqual({ version: 72, min_compatible: 56 })
    expect(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'facts'").get()?.sql).not.toContain(
      "AUTOINCREMENT",
    )
    database.close()
  })

  it("refuses a table that holds a column the copy would lose", async () => {
    const { path, database } = await fileAt72()
    database.exec("ALTER TABLE persons ADD COLUMN other_tool_flag INTEGER")
    expect(() => migrate(database, { now: () => 2, rollback: { store: path, freeBytes: plenty } })).toThrow(
      /copies persons without its columns other_tool_flag/,
    )
    expect(version(database)).toEqual({ version: 72, min_compatible: 56 })
    database.close()
  })
})
