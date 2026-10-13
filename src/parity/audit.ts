import type { CommandInfo } from "@wirecat/cli-base/commands"
import { type CommandsJson, longName, type Manifest, parityProblems } from "./manifest.js"
import { pageProblems } from "./pages.js"
import { wordingProblems } from "./wording.js"

/** What the audit reads from one CLI's checkout and build. Gathered by `scripts/parity-audit.ts`. */
export interface CliSide {
  commit: string
  /** The `@wirecat/*` packages it pins, by name. */
  pins: Record<string, string>
  program: CommandsJson
  /** `tools/list` of its MCP server with every `--allow-*`, prefix kept. */
  tools: string[]
  /** `README.md` and `docs/*.md`, by path from the checkout, with their text. */
  pages: Record<string, string>
  scripts: string[]
  skills: string[]
  /** Its CI workflows, with each `pnpm <script>` they run followed by that script's command. */
  ci: string
}

export interface AuditInput {
  shared: { commit: string; version: string }
  manifest: Manifest
  /** STANDARD.md, whose Documents rule names the pages one tool has alone. */
  standard: string
  /** Each CLI of the manifest that was measured, by name. */
  sides: Record<string, CliSide>
}

export interface Split {
  /** In every list. */
  all: string[]
  /** In some lists and not others, with the names of the lists that have it. */
  some: [string, string[]][]
}

export const split = (lists: Record<string, Iterable<string>>): Split => {
  const sets = Object.entries(lists).map(([cli, names]) => [cli, new Set(names)] as const)
  const names = [...new Set(sets.flatMap(([, set]) => [...set]))].sort()
  const having = (name: string) => sets.filter(([, set]) => set.has(name)).map(([cli]) => cli)
  return {
    all: names.filter((name) => having(name).length === sets.length),
    some: names
      .map((name) => [name, having(name)] as [string, string[]])
      .filter(([, clis]) => clis.length < sets.length),
  }
}

/** The pages that answer a user's question: the generated command list and the docs index are not counted. */
const NOT_PAGES = new Set(["docs/commands.md", "docs/README.md"])
const userPages = (side: CliSide) =>
  Object.keys(side.pages)
    .filter((path) => path.startsWith("docs/") && !NOT_PAGES.has(path))
    .map((path) => path.slice("docs/".length))
const lineCount = (text = "") => text.split("\n").length - 1

const apart = (counts: number[]) => {
  const [low, high] = [Math.min(...counts), Math.max(...counts)]
  return high - low > 2 && low < high * 0.75
}

/** `##` and `###` headings outside code blocks — the same in both languages, unlike the number of lines. */
export const headingCount = (text = "") => {
  let fenced = false
  let count = 0
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced
    else if (!fenced && /^#{2,3} /.test(line)) count++
  }
  return count
}

const documentsRule = (standard: string) => standard.split(/^## Documents$/m)[1]?.split(/^## /m)[0] ?? ""

export const pageSplit = (input: AuditInput) => {
  const pages = split(Object.fromEntries(Object.entries(input.sides).map(([cli, side]) => [cli, userPages(side)])))
  const rule = documentsRule(input.standard)
  const explained = (name: string) => rule.includes(`\`${name}\``)
  return { ...pages, explained }
}

export const readmeSections = (readme = "") => [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1] ?? "")

export const toolNames = (side: CliSide, cli: string) => side.tools.map((name) => name.replace(`${cli}_`, ""))

/** The `--allow-*` options of `mcp`; opt-in configuration may expose additional tools. */
export const allowFlags = (program: CommandsJson): string[] => {
  const mcp = program.commands.find((command: CommandInfo) => command.path.join(" ") === "mcp")
  return (mcp?.options ?? []).map((option) => longName(option.flags)).filter((name) => name.startsWith("--allow-"))
}

export const ciRuns = (side: CliSide) => ({
  parity: /cli-(?:core|messaging)-parity/.test(side.ci),
  pages: /cli-(?:core|messaging)-parity \S+ --pages/.test(side.ci),
})

const mark = (ok: boolean) => (ok ? "✅" : "🔴")
const code = (names: string[]) => (names.length === 0 ? "none" : names.map((name) => `\`${name}\``).join(", "))

/** A table of the names some CLIs have and others lack: one column per CLI. */
const table = (clis: string[], some: Split["some"]) =>
  some.length === 0
    ? []
    : [
        "",
        `| | ${clis.join(" | ")} |`,
        `|---|${clis.map(() => "---").join("|")}|`,
        ...some.map(
          ([name, having]) => `| \`${name}\` | ${clis.map((cli) => (having.includes(cli) ? "✅" : "—")).join(" | ")} |`,
        ),
      ]

/** The measured half of a parity audit, as Markdown: everything a script can say without judging. */
export const renderAudit = (input: AuditInput): string => {
  const { manifest, sides } = input
  const clis = Object.keys(sides)
  const each = <T>(read: (side: CliSide, cli: string) => T) => clis.map((cli) => read(sides[cli] as CliSide, cli))
  const out: string[] = []
  const section = (title: string) => out.push("", `### ${title}`, "")

  out.push(
    `## Measured from the ${clis.length} CLIs`,
    "",
    `cli-core \`${input.shared.commit}\` (${input.shared.version}) · ` +
      each((side, cli) => `${cli}-cli \`${side.commit}\``).join(" · ") +
      ". Statuses: ✅ agrees · 🔴 differs · ⚪ one-sided with a stated reason.",
  )

  section("The checks CI runs")
  for (const cli of clis) {
    const problems = parityProblems(manifest, cli, (sides[cli] as CliSide).program)
    out.push(
      `- ${mark(problems.length === 0)} **${cli} against this manifest** — ${problems.length} difference(s) ${code(problems)}`,
    )
  }
  const wording = wordingProblems(
    manifest,
    each((side) => side.program),
  )
  out.push(
    `- ${mark(wording.length === 0)} **Help sentences of shared options** — ${wording.length} differ ${code(wording)}`,
  )
  for (const cli of clis) {
    const side = sides[cli] as CliSide
    const pages = Object.entries(side.pages).flatMap(([name, text]) =>
      pageProblems(text, cli, manifest, side.program).map((found) => `${name}: ${found}`),
    )
    out.push(`- ${mark(pages.length === 0)} **${cli}'s pages name only real options** — ${code(pages)}`)
  }
  for (const cli of clis) {
    const runs = ciRuns(sides[cli] as CliSide)
    out.push(
      `- ${mark(runs.parity)} **${cli}'s CI runs the parity check**`,
      `- ${mark(runs.pages)} **${cli}'s CI runs the page check** (STANDARD, Documents rule 4)`,
    )
  }

  section("Shared package pinned")
  for (const name of ["@wirecat/cli-core", "@wirecat/cli-base"]) {
    const latest = name === "@wirecat/cli-core" ? input.shared.version : undefined
    const pins = each((side) => side.pins[name])
    const same = pins.every((pin) => pin === pins[0]) && (latest === undefined || pins[0] === latest)
    out.push(
      `- ${mark(same)} **${name}** — ` +
        clis.map((cli, index) => `${cli} ${pins[index] ?? "none"}`).join(", ") +
        (latest ? `, main ${latest}` : ""),
    )
  }

  section("MCP tools")
  const tools = split(Object.fromEntries(clis.map((cli) => [cli, toolNames(sides[cli] as CliSide, cli)])))
  out.push(`- **In every CLI** (${tools.all.length}) — ${code(tools.all)}`, ...table(clis, tools.some))

  section("User pages")
  const pages = pageSplit(input)
  for (const name of pages.all) {
    const texts = each((side) => side.pages[`docs/${name}`])
    const headings = texts.map((text) => headingCount(text))
    out.push(
      `- ${mark(!apart(headings))} \`${name}\` — ` +
        clis.map((cli, index) => `${cli} ${headings[index]}`).join(", ") +
        ` headings (${texts.map((text) => lineCount(text)).join(", ")} lines)`,
    )
  }
  for (const [name, having] of pages.some)
    out.push(
      `- ${pages.explained(name) ? "⚪" : "🔴"} \`${name}\` — only in ${having.join(", ")}; ` +
        (pages.explained(name) ? "STANDARD says why" : "STANDARD gives no reason"),
    )
  out.push(
    "",
    "A page is 🔴 when one CLI's copy has over a quarter, and more than two, fewer `##` and `###` headings than another's. Lines are not compared: Russian runs longer than English.",
  )

  section("README sections")
  const sections = each((side) => readmeSections(side.pages["README.md"]))
  out.push(
    `- ${mark(sections.every((one) => one.length === sections[0]?.length))} ` +
      clis.map((cli, index) => `${cli} ${sections[index]?.length}`).join(", "),
    ...clis.map((cli, index) => `- **${cli}:** ${sections[index]?.join(" · ")}`),
  )

  section("Release and QA tooling")
  const scripts = split(Object.fromEntries(clis.map((cli) => [cli, (sides[cli] as CliSide).scripts])))
  const skills = split(Object.fromEntries(clis.map((cli) => [cli, (sides[cli] as CliSide).skills])))
  out.push(
    `- **pnpm scripts not in every CLI** (${scripts.some.length})`,
    ...table(clis, scripts.some),
    "",
    `- **Skills in every CLI** — ${code(skills.all)}`,
    ...table(clis, skills.some),
  )
  return out.join("\n")
}
