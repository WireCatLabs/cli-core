/**
 * `cli-dev`: the development scripts every CLI on cli-core used to carry a copy of. Each command
 * reads and writes under `cwd` and reports through `out` and `err`; `main` returns the exit code.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import {
  type ChangelogRules,
  changelogProblems,
  type DocsRules,
  docsProblems,
  JOURNAL_IDS,
  markdownFiles,
  structureProblems,
  versionScript,
} from "../release/index.js"
import { nextVersion } from "./next-version.js"
import { slowTests, type VitestReport } from "./slow-tests.js"
import { matrixPage, matrixRows, type ProgramNode, parseArgvLog, type Untested } from "./test-matrix.js"

export interface DevIo {
  cwd: string
  out: (text: string) => void
  err: (text: string) => void
}

const USAGE = `usage: cli-dev <command> [options]

  slow-tests [report] [count]          the slowest tests and files (report: coverage/tests.json, count: 20)
  next-version <wanted> <latest> <versions-json>
                                       the version bin/release publishes, given npm's answers
  version [--sync] [--file <path>]     package.json's version against src/version.ts
  docs-check [--rules <module>] [--ids <A,B>] [--pages]
                                       links, anchors and the changelog's shape; --pages also
                                       docs/ against docs/meta.json, the docs portal's structure
  test-matrix --program <module> --untested <module> --name <cli> [--page <path>] [--check]
                                       docs/dev/test-matrix.md from coverage/argv.jsonl`

const load = async (cwd: string, path: string): Promise<Record<string, unknown>> =>
  (await import(pathToFileURL(isAbsolute(path) ? path : join(cwd, path)).href)) as Record<string, unknown>

const report = (io: DevIo, problems: readonly string[], ok: string) => {
  for (const problem of problems) io.err(problem)
  if (problems.length > 0) return 1
  io.out(ok)
  return 0
}

const docsCheck = async (args: string[], io: DevIo) => {
  const { values } = parseArgs({
    args,
    options: { rules: { type: "string" }, ids: { type: "string" }, pages: { type: "boolean" } },
  })
  const root = io.cwd
  let changelog: ChangelogRules
  let docs: DocsRules
  if (values.rules) {
    // A module exporting the rules the release check uses too: `CHANGELOG` and `docsRules(root)`.
    const rules = await load(root, values.rules)
    changelog = rules.CHANGELOG as ChangelogRules
    docs = (rules.docsRules as (root: string) => DocsRules)(root)
  } else {
    const ids = [...JOURNAL_IDS, ...(values.ids?.split(",").filter(Boolean) ?? [])]
    changelog = {
      headings: ["Added", "Changed — may break callers", "Fixed", "Security", "Removed"],
      unreleased: "Unreleased",
      ids,
    }
    docs = { files: markdownFiles(root, new Set(["node_modules", "dist", "coverage", ".git", "docs_ai"])), ids }
  }
  return report(
    io,
    [
      ...changelogProblems(readFileSync(join(root, "CHANGELOG.md"), "utf8"), { ...changelog, release: false }),
      ...docsProblems(root, docs),
      ...(values.pages ? structureProblems(root) : []),
    ],
    "docs: ok",
  )
}

const testMatrix = async (args: string[], io: DevIo) => {
  const { values } = parseArgs({
    args,
    options: {
      program: { type: "string" },
      untested: { type: "string" },
      name: { type: "string" },
      page: { type: "string", default: "docs/dev/test-matrix.md" },
      check: { type: "boolean", default: false },
    },
  })
  if (!values.program || !values.untested || !values.name) {
    io.err("test-matrix needs --program, --untested and --name")
    return 2
  }
  const log = join(io.cwd, "coverage", "argv.jsonl")
  if (!existsSync(log)) {
    io.err("no coverage/argv.jsonl — run the suite first (pnpm test:matrix does)")
    return 1
  }
  const program = ((await load(io.cwd, values.program)).createProgram as () => ProgramNode)()
  const untested = (await load(io.cwd, values.untested)).UNTESTED as Untested[]
  const { rows, stale } = matrixRows(program, parseArgvLog(readFileSync(log, "utf8")), untested)
  writeFileSync(join(io.cwd, values.page), matrixPage(rows, values.name))

  let failed = false
  if (stale.length > 0) {
    failed = true
    io.err("untested entries that name nothing in the program any more:")
    for (const entry of stale) io.err(`  ${entry.command}${entry.option ? ` ${entry.option}` : ""}`)
  }
  const missing = rows.filter((row) => row.state === "missing")
  if (missing.length > 0 && values.check) {
    failed = true
    io.err(`${missing.length} commands or options with no test and no reason — see ${values.page}:`)
    for (const row of missing) io.err(`  ${row.command || "(global)"}${row.option ? ` ${row.option}` : ""}`)
  }
  const count = (state: string) => rows.filter((row) => row.state === state).length
  io.err(
    `test matrix: ${count("tested")} tested, ${count("untested")} untested with a reason, ${missing.length} missing`,
  )
  return failed ? 1 : 0
}

export const main = async (argv: readonly string[], io: DevIo): Promise<number> => {
  const [command, ...args] = argv
  switch (command) {
    case "slow-tests": {
      const [file = "coverage/tests.json", count = "20"] = args
      const parsed = JSON.parse(readFileSync(join(io.cwd, file), "utf8")) as VitestReport
      io.out(slowTests(parsed, io.cwd, Number(count)))
      return 0
    }
    case "next-version": {
      const [wanted = "", latest = "", versions = ""] = args
      const found = nextVersion(wanted, latest, versions)
      if ("error" in found) {
        io.err(found.error)
        return 1
      }
      io.out(found.version)
      return 0
    }
    case "version": {
      const { values } = parseArgs({
        args,
        options: { sync: { type: "boolean", default: false }, file: { type: "string", default: "src/version.ts" } },
      })
      const { code, message } = versionScript(io.cwd, values.sync ? ["--sync"] : [], values.file)
      if (code === 0) io.out(message)
      else io.err(message)
      return code
    }
    case "docs-check":
      return docsCheck(args, io)
    case "test-matrix":
      return testMatrix(args, io)
    case "help":
    case "--help":
    case "-h":
      io.out(USAGE)
      return 0
    default:
      io.err(command ? `cli-dev: no command "${command}"\n\n${USAGE}` : USAGE)
      return 2
  }
}
