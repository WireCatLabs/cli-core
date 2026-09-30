/**
 * Everything about a release that a program can decide. Each check returns the problems it found,
 * one line each, saying what and where; an empty list is a pass. The judgement half — changelog
 * wording, docs against the diff, live checks — is each CLI's release skill.
 */
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export {
  type ChangelogRules,
  changelogProblems,
  type DocsRules,
  docsProblems,
  idPattern,
  JOURNAL_IDS,
  markdownFiles,
  slug,
} from "./markdown.js"

export type Check = { name: string; run: () => string[] }

/**
 * Runs every check even after one fails, so one pass shows the whole list, and returns how many
 * failed. The caller exits: a library that calls `process.exit` cannot be tested.
 */
export const releaseCheck = (
  checks: readonly Check[],
  { version, log }: { version: string; log: (line: string) => void },
) => {
  let failed = 0
  for (const { name, run } of checks) {
    const problems = run()
    log(`${problems.length === 0 ? "ok  " : "FAIL"}  ${name}`)
    for (const problem of problems) log(problem.replace(/^/gm, "      "))
    if (problems.length > 0) failed++
  }
  log(failed === 0 ? `\n${version}: every check passed` : `\n${version}: ${failed} check(s) failed`)
  return failed
}

export const run = (root: string, command: string, args: readonly string[]) => {
  const done = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  const output = `${done.stdout ?? ""}${done.stderr ?? ""}${done.error ? String(done.error) : ""}`
  return { ok: done.status === 0, output }
}

/** A check that passes when the command exits 0, and otherwise shows the last 15 lines it printed. */
export const command =
  (root: string, name: string, ...args: string[]) =>
  (): string[] => {
    const { ok, output } = run(root, name, args)
    return ok ? [] : [output.trim().split("\n").slice(-15).join("\n") || `exit ${name} ${args.join(" ")}`]
  }

export const packageVersion = (root: string) =>
  (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version

export const notOnNpm = (root: string, packageName: string, version: string) => (): string[] =>
  run(root, "npm", ["view", `${packageName}@${version}`, "version", "--prefer-online"]).ok
    ? [`${version} is already on npm — raise the version`]
    : []

/**
 * `allowed` holds exact paths, and directories ending in `/`; `said` is how the problem names them.
 */
export const packProblems = (paths: readonly string[], allowed: readonly string[], said: string) =>
  paths
    .filter((path) => !allowed.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry)))
    .map((path) => `npm pack: ${path} would ship — only ${said} may`)

export const packContents = (root: string, allowed: readonly string[], said: string) => (): string[] => {
  const { ok, output } = run(root, "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"])
  if (!ok) return [output.trim()]
  const [packed] = JSON.parse(output.slice(output.indexOf("["))) as { files: { path: string }[] }[]
  return packProblems(
    (packed?.files ?? []).map(({ path }) => path),
    allowed,
    said,
  )
}

const VERSION = /export const VERSION = "([^"]*)"/

const versionsOf = (root: string, file: string) => {
  const declared: unknown = packageVersion(root)
  if (typeof declared !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(declared))
    return `package.json has no usable "version" (got ${JSON.stringify(declared)})`
  const source = readFileSync(join(root, file), "utf8")
  const current = VERSION.exec(source)?.[1]
  if (!current) return `${file} does not export a VERSION string`
  return { declared, current, source }
}

/**
 * The whole of a `version:check` / `version:sync` script: what to print, and the exit code — 2 when
 * either file cannot be read, 1 on drift. A CLI keeps its version in `package.json` and in a source
 * file read at run time — `--version` must not load `package.json`, which is not there once the
 * command is bundled — and the day they disagree is a release day.
 */
export const versionScript = (
  root: string,
  argv: readonly string[],
  file = "src/version.ts",
): { code: 0 | 1 | 2; message: string } => {
  const found = versionsOf(root, file)
  if (typeof found === "string") return { code: 2, message: found }
  const { declared, current, source } = found
  if (argv.includes("--sync")) {
    if (current === declared) return { code: 0, message: `version ${declared} — already in step` }
    writeFileSync(join(root, file), source.replace(`"${current}"`, `"${declared}"`))
    return { code: 0, message: `${file}: ${current} → ${declared}` }
  }
  if (current !== declared)
    return {
      code: 1,
      message:
        `version drift: package.json says ${declared}, ${file} says ${current}.\n` +
        "Run `pnpm version:sync` — package.json is the one that is edited.",
    }
  return { code: 0, message: `version ${declared} — package.json and ${file} agree` }
}
