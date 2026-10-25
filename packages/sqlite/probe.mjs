// biome-ignore-all lint/plugin/no-sqlite-driver: cli-core owns the store, so it opens the driver itself
// Checks that a runtime runs on the library given, that it can hold the store, and that it loads the
// vector extension and answers a partitioned nearest-neighbour query:
//   bun packages/sqlite/probe.mjs <library> <version> <extension>      (Bun loads it itself)
//   LD_LIBRARY_PATH=<dir> node packages/sqlite/probe.mjs - <version> <extension>
const [library, expected, extension] = process.argv.slice(2)

const open = async () => {
  if (globalThis.Bun) {
    const { Database } = await import("bun:sqlite")
    if (library !== "-") Database.setCustomSQLite(library)
    const database = new Database(":memory:")
    if (extension) database.loadExtension(extension)
    return { exec: (sql) => database.exec(sql), get: (sql) => database.query(sql).get() }
  }
  const { DatabaseSync } = await import("node:sqlite")
  const database = new DatabaseSync(":memory:", { allowExtension: true })
  if (extension) database.loadExtension(extension)
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
if (extension) {
  database.exec(`CREATE VIRTUAL TABLE vectors USING vec0(kind text partition key, account integer partition key,
                   occurred_at integer, chat integer, embedding float[2] distance_metric=cosine, +hash text)`)
  database.exec(`INSERT INTO vectors (rowid, kind, account, occurred_at, chat, embedding, hash) VALUES
                   (1, 'message', 1, 10, 7, vec_f32('[1, 0]'), 'a'), (2, 'message', 1, 20, 7, vec_f32('[0, 1]'), 'b'),
                   (3, 'message', 2, 20, 7, vec_f32('[1, 0]'), 'c')`)
  const nearest = database.get(`SELECT rowid FROM vectors WHERE embedding MATCH vec_f32('[0.9, 0.1]') AND k = 1
                                  AND kind = 'message' AND account = 1 AND occurred_at >= 5 AND chat = 7`)
  if (nearest?.rowid !== 1) throw new Error(`vec0 answered ${JSON.stringify(nearest)}, not rowid 1`)
  console.log(`ok: ${database.get("SELECT vec_version() AS v").v}`)
}
console.log(`ok: SQLite ${version} under ${globalThis.Bun ? `Bun ${Bun.version}` : `Node ${process.version}`}`)
