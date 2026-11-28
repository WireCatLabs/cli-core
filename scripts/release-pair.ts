/**
 * Turns the one validated tarball into the two packages a release publishes: X.Y.Z, which users install, without
 * type files, maps or src/, and X.Y.Z-dev, the same files under the -dev version, which CLI repositories install
 * through their root override to get the types (docs/dev/RELEASING.md). Fails unless every runtime file is
 * byte-identical in the two, so a CLI tested against -dev runs the code its users get.
 *
 *   node scripts/release-pair.ts wirecat-cli-core-<version>.tgz <out-dir>
 */
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { scratch } from "./scratch.ts"

export const DEV_SUFFIX = "-dev"

/** What users do not get: the type files, every map, and the sources the maps point at. */
export const developerOnly = (path: string): boolean =>
  path.startsWith("src/") || /\.d\.ts$|\.d\.ts\.map$|\.js\.map$/.test(path)

const filesUnder = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .replaceAll("\\", "/"),
    )
    .sort()

const withoutVersion = (text: string) => {
  const { version: _, ...rest } = JSON.parse(text) as Record<string, unknown>
  return JSON.stringify(rest)
}

/** Every problem that makes the two unpacked packages unsafe to publish as a pair; none means they are. */
export const pairProblems = (lean: string, dev: string, version: string): string[] => {
  const problems: string[] = []
  const leanFiles = filesUnder(lean)
  const devFiles = filesUnder(dev)
  for (const path of leanFiles.filter(developerOnly)) problems.push(`${version} ships ${path}`)
  if (!devFiles.includes("dist/index.d.ts")) problems.push(`${version}${DEV_SUFFIX} has no dist/index.d.ts`)
  const runtime = devFiles.filter((path) => !developerOnly(path))
  const leanSet = new Set(leanFiles)
  for (const path of runtime.filter((path) => !leanSet.has(path))) problems.push(`only ${version}-dev ships ${path}`)
  const devSet = new Set(runtime)
  for (const path of leanFiles.filter((path) => !devSet.has(path) && !developerOnly(path)))
    problems.push(`only ${version} ships ${path}`)
  for (const path of runtime.filter((path) => leanSet.has(path))) {
    const a = readFileSync(join(lean, path))
    const b = readFileSync(join(dev, path))
    if (path === "package.json") {
      if (withoutVersion(a.toString("utf8")) !== withoutVersion(b.toString("utf8")))
        problems.push("package.json differs in more than the version")
      if (JSON.parse(a.toString("utf8")).version !== version)
        problems.push(`${version}'s package.json is not ${version}`)
      if (JSON.parse(b.toString("utf8")).version !== `${version}${DEV_SUFFIX}`)
        problems.push(`the -dev package.json is not ${version}${DEV_SUFFIX}`)
    } else if (!a.equals(b)) problems.push(`${path} differs between ${version} and ${version}${DEV_SUFFIX}`)
  }
  return problems
}

const unpack = (tarball: string, into: string) => {
  mkdirSync(into, { recursive: true })
  execFileSync("tar", ["-xzf", tarball, "-C", into])
  return join(into, "package")
}

const pack = (dir: string, out: string) =>
  execFileSync("npm", ["pack", "--ignore-scripts", "--loglevel=warn", "--pack-destination", out], {
    cwd: dir,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .at(-1) as string

const main = (tarball: string, outDir: string) => {
  const work = scratch("release-pair-")
  const full = unpack(resolve(tarball), join(work, "full"))
  const manifest = readFileSync(join(full, "package.json"), "utf8")
  const { version } = JSON.parse(manifest) as { version: string }
  if (version.endsWith(DEV_SUFFIX)) throw new Error(`${tarball} is already a ${DEV_SUFFIX} package`)

  const leanDir = join(work, "lean")
  cpSync(full, leanDir, { recursive: true })
  for (const path of filesUnder(leanDir).filter(developerOnly)) rmSync(join(leanDir, path))
  rmSync(join(leanDir, "src"), { recursive: true, force: true })

  const devDir = join(work, "dev")
  cpSync(full, devDir, { recursive: true })
  const versionLine = `"version": "${version}"`
  if (!manifest.includes(versionLine)) throw new Error(`package.json has no ${versionLine} line`)
  writeFileSync(join(devDir, "package.json"), manifest.replace(versionLine, `"version": "${version}${DEV_SUFFIX}"`))

  const out = resolve(outDir)
  mkdirSync(out, { recursive: true })
  const leanTarball = join(out, pack(leanDir, out))
  const devTarball = join(out, pack(devDir, out))

  const problems = pairProblems(
    unpack(leanTarball, join(work, "check-lean")),
    unpack(devTarball, join(work, "check-dev")),
    version,
  )
  if (problems.length > 0) {
    console.error(`the ${version} pair is not safe to publish:\n${problems.map((line) => `  ${line}`).join("\n")}`)
    process.exit(1)
  }
  const files = (dir: string) => filesUnder(dir).length
  console.log(`${leanTarball}: ${files(join(work, "check-lean"))} files, for users`)
  console.log(`${devTarball}: ${files(join(work, "check-dev"))} files, the same runtime files plus types and src/`)
}

if (import.meta.main) {
  const [tarball, outDir] = process.argv.slice(2)
  if (!tarball || !outDir) {
    console.error("usage: node scripts/release-pair.ts <package.tgz> <out-dir>")
    process.exit(2)
  }
  main(tarball, outDir)
}
