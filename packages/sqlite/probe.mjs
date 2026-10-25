// biome-ignore-all lint/plugin/no-sqlite-driver: cli-core owns the store, so it opens the driver itself
// Checks that a runtime runs on the library given and that it can hold the store:
//   bun packages/sqlite/probe.mjs <library> <version>      (Bun loads it itself)
//   LD_LIBRARY_PATH=<dir> node packages/sqlite/probe.mjs - <version>
const [library, expected] = process.argv.slice(2)

const open = async () => {
  if (globalThis.Bun) {
    const { Database } = await import("bun:sqlite")
    if (library !== "-") Database.setCustomSQLite(library)
    const database = new Database(":memory:")
    return { exec: (sql) => database.exec(sql), get: (sql) => database.query(sql).get() }
  }
  const { DatabaseSync } = await import("node:sqlite")
  const database = new DatabaseSync(":memory:")
  return { exec: (sql) => database.exec(sql), get: (sql) => database.prepare(sql).get() }
}

const database = await open()
const { version } = database.get("SELECT sqlite_version() AS version")
if (version !== expected) throw new Error(`runs on SQLite ${version}, not ${expected}`)
database.exec(`CREATE VIRTUAL TABLE words USING fts5(text, scope, content = '', contentless_delete = 1,
                 tokenize = 'unicode61 remove_diacritics 2', prefix = '3')`)
database.exec("CREATE VIRTUAL TABLE substrings USING fts5(text, tokenize = 'trigram')")
database.exec("INSERT INTO words (rowid, text, scope) VALUES (1, 'hola', 'c1'), (2, 'adios', 'c1')")
database.exec("DELETE FROM words WHERE rowid = 1")
database.exec("INSERT INTO words (words, rank) VALUES ('integrity-check', 1)")
console.log(`ok: SQLite ${version} under ${globalThis.Bun ? `Bun ${Bun.version}` : `Node ${process.version}`}`)
