/**
 * The milestone parity audit: where the CLIs stand, from `parity.json` — what all have, what is
 * planned and by whom, what some lack and why, and the option clashes still open. Given every CLI's
 * checkout, built, it also measures them: the checks CI runs, the shared versions they pin, their MCP
 * tools, user pages, README sections and release tooling. Markdown on stdout.
 *
 *   pnpm parity:audit                          # the manifest alone
 *   pnpm parity:audit --max <dir> --tg <dir>   # and a built checkout of each CLI in "clis"
 *   pnpm parity:audit --fresh                  # clones and builds each CLI's main first
 *
 * Nothing contacts Telegram or MAX: each MCP server starts in an empty temporary home, with no
 * profile, and is asked only for its list of tools.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { type CliSide, renderAudit } from "../dist/parity/audit.js"
import type { CommandRow, CommandsJson, Entry, Manifest } from "../dist/parity/manifest.js"
import { runDeepAudit } from "./parity/deep-audit.ts"
import { mcpSchemas, sandboxEnvironment, temporaryHome } from "./parity/evidence.ts"

const root = join(import.meta.dirname, "..")
const manifest: Manifest = JSON.parse(readFileSync(join(root, "parity.json"), "utf8"))
const { values } = parseArgs({
  options: {
    ...Object.fromEntries(manifest.clis.map((cli) => [cli, { type: "string" as const }])),
    fresh: { type: "boolean" as const },
    deep: { type: "boolean" as const },
    output: { type: "string" as const },
    "skip-checks": { type: "boolean" as const },
  },
})
if (values.output && existsSync(resolve(values.output))) throw new Error("choose a new output directory")
if (values.deep && !values.output) throw new Error("--deep requires --output <new-directory>")
if (!values.deep && (values.output || values["skip-checks"])) throw new Error("--output/--skip-checks require --deep")

const dirOf = (cli: string) => (values as Record<string, string | boolean | undefined>)[cli]
const given = manifest.clis.filter((cli) => typeof dirOf(cli) === "string")

interface Line {
  what: string
  row: Exclude<Entry, "all">
}
const lines: Line[] = []
const add = (what: string, entry: Entry | CommandRow) =>
  lines.push({ what, row: entry === "all" ? { in: "all" } : entry })
for (const [name, entry] of Object.entries(manifest.globalOptions)) add(`(global) ${name}`, entry)
for (const [path, row] of Object.entries(manifest.commands)) {
  add(path, row)
  for (const [name, entry] of Object.entries(row.options ?? {})) add(`${path} ${name}`, entry)
}

const has = (line: Line, cli: string) => line.row.in === "all" || line.row.in.includes(cli)
const plannedFor = (line: Line, cli: string) => line.row.planned?.[cli]
const lacks = (line: Line, cli: string) => !has(line, cli) && plannedFor(line, cli) === undefined
const count = (test: (line: Line) => boolean, options: boolean) =>
  lines.filter((line) => test(line) && line.what.includes(" --") === options).length
const out: string[] = [`# Parity of ${manifest.clis.join(", ")}`, "", "| | Commands | Options |", "|---|---|---|"]
const row = (label: string, test: (line: Line) => boolean) =>
  out.push(`| ${label} | ${count(test, false)} | ${count(test, true)} |`)
row("in every CLI", (line) => line.row.in === "all")
for (const cli of manifest.clis) {
  row(`planned for ${cli}`, (line) => plannedFor(line, cli) !== undefined)
  row(`not in ${cli}, for a reason`, (line) => lacks(line, cli))
}

const planned = new Map<string, Map<string, string[]>>()
for (const line of lines)
  for (const [cli, by] of Object.entries(line.row.planned ?? {})) {
    const group = planned.get(by) ?? new Map<string, string[]>()
    group.set(line.what, [...(group.get(line.what) ?? []), cli])
    planned.set(by, group)
  }
out.push("", "## Planned, by who closes it", "")
for (const [by, group] of [...planned].sort(([a], [b]) => a.localeCompare(b)))
  out.push(
    `- **${by}** (${group.size}): ${[...group].map(([what, clis]) => `\`${what}\` (${clis.join(", ")})`).join(", ")}`,
  )

out.push("", "## Not in every CLI, and why", "")
for (const line of lines.filter((one) => one.row.reason))
  out.push(
    `- \`${line.what}\` — not in ${manifest.clis.filter((cli) => lacks(line, cli)).join(", ")}: ${line.row.reason}`,
  )

out.push("", "## Option clashes still open", "")
for (const [name, option] of Object.entries(manifest.options))
  if (option.note) out.push(`- \`${name}\` — ${option.note}`)

const retainedPaths: string[] = []
const auditHome = () => {
  const path = temporaryHome()
  retainedPaths.push(path)
  return path
}

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()

/** A CLI's repository, where it is not `<cli>-cli`. */
const REPOSITORIES: Record<string, string> = { wa: "whatsapp-cli" }

const fresh = (): Record<string, string> => {
  const dir = mkdtempSync(join(tmpdir(), "parity-audit-"))
  retainedPaths.push(dir)
  for (const cli of manifest.clis) {
    const into = join(dir, cli)
    const repository = REPOSITORIES[cli] ?? `${cli}-cli`
    console.error(`cloning and building ${repository} into ${into}`)
    execFileSync("git", [
      "clone",
      "-q",
      "--branch",
      "main",
      "--depth",
      "1",
      `https://github.com/WireCatLabs/${repository}.git`,
      into,
    ])
    const env = sandboxEnvironment(auditHome())
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: into, stdio: "ignore", env })
    execFileSync("pnpm", ["build"], { cwd: into, stdio: "ignore", env })
  }
  return Object.fromEntries(manifest.clis.map((cli) => [cli, join(dir, cli)]))
}

const mcpTools = async (bin: string): Promise<string[]> =>
  (await mcpSchemas(bin, ["mcp", "serve"], sandboxEnvironment(auditHome()))).map((tool) => tool.name).sort()

const markdown = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".md")) : [])

const side = async (cli: string, dir: string): Promise<CliSide> => {
  const bin = join(dir, "dist/bin", `${cli}.js`)
  const program: CommandsJson = JSON.parse(
    execFileSync("node", [bin, "commands", "--json"], { encoding: "utf8", env: sandboxEnvironment(auditHome()) }),
  )
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  const scripts: Record<string, string> = pkg.scripts ?? {}
  const pins = Object.fromEntries(
    Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([name]) => name.startsWith("@wirecat/")),
  ) as Record<string, string>
  const pages: Record<string, string> = { "README.md": readFileSync(join(dir, "README.md"), "utf8") }
  for (const name of markdown(join(dir, "docs"))) pages[`docs/${name}`] = readFileSync(join(dir, "docs", name), "utf8")
  const workflows = join(dir, ".github/workflows")
  const ci = readdirSync(workflows)
    .map((name) => readFileSync(join(workflows, name), "utf8"))
    .join("\n")
    .replace(/pnpm (?:run )?([\w:-]+)/g, (run, name: string) => `${run} ${scripts[name] ?? ""}`)
  const skills = [".claude/skills", "docs/dev/skills"].flatMap((folder) =>
    existsSync(join(dir, folder)) ? readdirSync(join(dir, folder)) : [],
  )
  return {
    commit: git(dir, "rev-parse", "--short", "HEAD"),
    pins,
    program,
    tools: await mcpTools(bin),
    pages,
    scripts: Object.keys(scripts).filter((name) => !name.startsWith("probe:")),
    skills,
    ci,
  }
}

const dirs = values.fresh
  ? fresh()
  : given.length === manifest.clis.length
    ? Object.fromEntries(given.map((cli) => [cli, String(dirOf(cli))]))
    : undefined
if (dirs) {
  const sides = Object.fromEntries(
    await Promise.all(Object.entries(dirs).map(async ([cli, dir]) => [cli, await side(cli, dir)] as const)),
  )
  out.push(
    "",
    renderAudit({
      shared: {
        commit: git(root, "rev-parse", "--short", "HEAD"),
        version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
      },
      manifest,
      standard: readFileSync(join(root, "docs/dev/STANDARD.md"), "utf8"),
      sides,
    }),
  )
} else if (given.length > 0) {
  console.error(`usage: pnpm parity:audit [--fresh | ${manifest.clis.map((cli) => `--${cli} <dir>`).join(" ")}]`)
  process.exit(2)
}
if (values.deep) {
  if (!dirs) throw new Error("--deep requires --fresh or both --max and --tg checkouts")
  const ok = await runDeepAudit({
    root,
    dirs,
    manifest,
    output: String(values.output),
    skipChecks: values["skip-checks"],
    retainedPaths,
    surface: out.join("\n"),
  })
  if (!ok) process.exitCode = 1
} else console.log(out.join("\n"))
