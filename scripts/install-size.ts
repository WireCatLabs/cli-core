/**
 * Installs a packed tarball of this package into an empty folder, as a user's `npm i` would, and fails when its
 * node_modules takes more disk than the ceiling in install-size.json. Disk use, not bytes in files: that is what a
 * person sees, and what docs/dev/plans/2026-10-18-install-size.md measures.
 *
 *   node scripts/install-size.ts wirecat-cli-core-<version>.tgz
 */
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { scratch } from "./scratch.ts"

const CEILING_FILE = join(import.meta.dirname, "install-size.json")

const tarball = process.argv[2]
if (!tarball) {
  console.error("usage: node scripts/install-size.ts <package.tgz>")
  process.exit(2)
}

const { ceilingMB } = JSON.parse(readFileSync(CEILING_FILE, "utf8")) as { ceilingMB: number }
const dir = scratch("install-size-")
writeFileSync(join(dir, "package.json"), "{}")
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", resolve(tarball)], {
  cwd: dir,
  stdio: ["ignore", "ignore", "inherit"],
})

const diskKB = (path: string) => Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split("\t")[0])
const mb = (kb: number) => (kb / 1024).toFixed(1)

const modules = join(dir, "node_modules")
const packages = readdirSync(modules)
  .filter((name) => !name.startsWith("."))
  .flatMap((name) => (name.startsWith("@") ? readdirSync(join(modules, name)).map((n) => `${name}/${n}`) : [name]))
  .map((name) => ({ name, kb: diskKB(join(modules, name)) }))
  .sort((a, b) => b.kb - a.kb)

const total = diskKB(modules)
console.log(`install size: ${mb(total)} MB on disk, ${packages.length} top-level packages, ceiling ${ceilingMB} MB`)
for (const { name, kb } of packages.slice(0, 5)) console.log(`  ${mb(kb).padStart(6)} MB  ${name}`)

if (total > ceilingMB * 1024) {
  console.error(`install size ${mb(total)} MB is above the ceiling of ${ceilingMB} MB in scripts/install-size.json`)
  process.exit(1)
}
