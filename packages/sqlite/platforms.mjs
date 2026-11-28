// Lays out one npm package per platform in npm/<target>/ from the libraries build.sh put in lib/<target>/,
// at the version @wirecat/cli-core-sqlite pins it in optionalDependencies. Each install takes only its own.
//
//   node packages/sqlite/platforms.mjs
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const here = import.meta.dirname
const main = JSON.parse(readFileSync(join(here, "package.json"), "utf8"))

const targets = {
  darwin: { os: ["darwin"], cpu: ["arm64", "x64"] },
  "linux-x64-gnu": { os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
  "linux-arm64-gnu": { os: ["linux"], cpu: ["arm64"], libc: ["glibc"] },
  "linux-x64-musl": { os: ["linux"], cpu: ["x64"], libc: ["musl"] },
  "linux-arm64-musl": { os: ["linux"], cpu: ["arm64"], libc: ["musl"] },
  "win32-x64": { os: ["win32"], cpu: ["x64"] },
}

const pinned = main.optionalDependencies ?? {}
const names = Object.keys(targets).map((target) => `${main.name}-${target}`)
const unpinned = names.filter((name) => pinned[name] !== main.version)
const unknown = Object.keys(pinned).filter((name) => !names.includes(name))
if (unpinned.length > 0 || unknown.length > 0) {
  throw new Error(
    `optionalDependencies must pin exactly ${names.join(", ")} at ${main.version}; ` +
      `wrong: ${[...unpinned, ...unknown].join(", ")}`,
  )
}

for (const [target, platform] of Object.entries(targets)) {
  const lib = join(here, "lib", target)
  if (!existsSync(lib)) throw new Error(`no libraries in ${lib}: build.sh ${target} first`)
  const out = join(here, "npm", target)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const files = readdirSync(lib)
  for (const file of files) copyFileSync(join(lib, file), join(out, file))
  copyFileSync(join(here, "LICENSE"), join(out, "LICENSE"))
  const manifest = {
    name: `${main.name}-${target}`,
    version: main.version,
    description: `${main.description}: the libraries for ${target}`,
    license: main.license,
    repository: main.repository,
    ...platform,
    files: [...files, "LICENSE"],
  }
  writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(out)
}
