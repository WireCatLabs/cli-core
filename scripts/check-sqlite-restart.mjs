// A distribution's Node whose system SQLite cannot hold the store must start again on ours, open the
// store, and hand the user's library path back to what it runs. Run on that Node after `pnpm build`,
// with an unfit SQLite first on LD_LIBRARY_PATH; `wait` keeps it running for the signal check.
import { execSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { ensureSqlite } = await import("../dist/sqlite-runtime.js")
await ensureSqlite()
const { SQLITE_VERSION } = await import("@wirecat/cli-core-sqlite")
const { openCache } = await import("../dist/store/open.js")
const { openStore } = await import("../dist/store/store.js")

const memory = await openCache(":memory:")
const version = memory.prepare("SELECT sqlite_version() AS version").get()?.version
memory.close()
if (version !== SQLITE_VERSION) throw new Error(`runs on SQLite ${version}, not ours (${SQLITE_VERSION})`)
await (await openStore({ path: join(mkdtempSync(join(tmpdir(), "restart-")), "messages.db") })).close()
const seen = execSync("sh -c 'echo $LD_LIBRARY_PATH'").toString().trim()
if (seen !== process.argv[2]) throw new Error(`a child sees LD_LIBRARY_PATH=${seen}, not the user's ${process.argv[2]}`)
console.log(`restart: SQLite ${version}, the store opened, children see ${seen}`)
if (process.argv[3] === "wait") setInterval(() => {}, 1_000)
