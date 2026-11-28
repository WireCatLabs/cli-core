// Prints where @wirecat/cli-core-sqlite, installed under <dir>, finds this platform's library or extension, as
// cli-core asks it; fails when it finds none.
//   node packages/sqlite/where.mjs <dir> library|extension
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"

const [dir, what] = process.argv.slice(2)
const { libraryFor, extensionFor } = await import(
  createRequire(resolve(dir, "x.js")).resolve("@wirecat/cli-core-sqlite")
)
let musl = false
try {
  musl = readFileSync("/proc/self/maps", "utf8").includes("ld-musl")
} catch {}
const path = (what === "library" ? libraryFor : extensionFor)({ musl })
if (path === undefined) throw new Error(`no ${what} for ${process.platform}-${process.arch}${musl ? "-musl" : ""}`)
console.log(path)
