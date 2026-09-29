/**
 * Every relative link and anchor in every Markdown file resolves, and the changelog keeps its shape —
 * on every pull request, so a stale link fails the change that made it.
 *
 *   pnpm docs:check
 *
 * The link and anchor rules are max-cli's `scripts/release/checks.ts`, trimmed to what applies here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const HEADINGS = ["Added", "Changed — may break callers", "Fixed", "Security", "Removed"] as const
const UNRELEASED = "Unreleased"

const ID = /\b(?:CLI|MAX|OPS|CORE|SPEC|DOC|RISK|NEED|BUG|FIND|SEC|PERF|UX|IDEA|DEBT|ASK|TASK)-\d+\b/g
const VERSION_HEADING = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) — (\d{2})\.(\d{2})\.(\d{4})$/
const SKIPPED = new Set(["node_modules", "dist", "coverage", ".git", "docs_ai"])

const changelogProblems = (text: string) => {
  const problems: string[] = []
  let section = ""
  let subheadings = new Set<string>()
  let first = true
  text.split("\n").forEach((line, index) => {
    const where = `CHANGELOG.md:${index + 1}`
    if (line.startsWith("## ")) {
      section = line.slice(3)
      subheadings = new Set()
      if (section === UNRELEASED) {
        if (!first) problems.push(`${where}: "${UNRELEASED}" must be the top section`)
      } else {
        const found = VERSION_HEADING.exec(line)
        if (!found) problems.push(`${where}: "${line}" is not "## <version> — DD.MM.YYYY"`)
        else if (Number(found[2]) < 1 || Number(found[2]) > 31 || Number(found[3]) < 1 || Number(found[3]) > 12)
          problems.push(`${where}: "${line}" has no such date`)
      }
      first = false
      return
    }
    if (line.startsWith("### ")) {
      const heading = line.slice(4)
      if (!(HEADINGS as readonly string[]).includes(heading))
        problems.push(`${where}: "${heading}" is not one of: ${HEADINGS.join(", ")}`)
      if (subheadings.has(heading)) problems.push(`${where}: "${heading}" twice in "${section}"`)
      subheadings.add(heading)
    }
    for (const id of line.match(ID) ?? []) problems.push(`${where}: internal id ${id} — say what changed instead`)
  })
  return problems
}

/** GitHub's heading anchor: lower case, only letters, digits, `-`, `_` and spaces kept, spaces to `-`. */
const slug = (heading: string) =>
  heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\-_ ]/gu, "")
    .replace(/ /g, "-")

const withoutCode = (text: string) =>
  text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (block) => block.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length))

// Headings are read from the raw text, so code inside a heading still counts toward its anchor.
const anchorsOf = (text: string) => {
  const raw = text.split("\n")
  const anchors = new Set<string>()
  const counts = new Map<string, number>()
  withoutCode(text)
    .split("\n")
    .forEach((masked, index) => {
      if (!/^#{1,6} /.test(masked)) return
      const heading = /^#{1,6} (.+?)\s*#*\s*$/.exec(raw[index] ?? "")?.[1]
      if (heading === undefined) return
      const base = slug(heading)
      const seen = counts.get(base) ?? 0
      counts.set(base, seen + 1)
      anchors.add(seen === 0 ? base : `${base}-${seen}`)
    })
  for (const [, name = ""] of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(name)
  return anchors
}

const markdownFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return []
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.name.endsWith(".md") ? [path] : []
  })

const linkProblems = () => {
  const cache = new Map<string, Set<string>>()
  const anchors = (path: string) => {
    let found = cache.get(path)
    if (!found) {
      found = anchorsOf(readFileSync(path, "utf8"))
      cache.set(path, found)
    }
    return found
  }
  const problems: string[] = []
  for (const path of markdownFiles(root)) {
    withoutCode(readFileSync(path, "utf8"))
      .split("\n")
      .forEach((line, index) => {
        const where = `${relative(root, path)}:${index + 1}`
        for (const [, target] of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
          if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
          const [file = "", anchor] = decodeURIComponent(target).split("#")
          const destination = file === "" ? path : resolve(dirname(path), file)
          if (!existsSync(destination)) {
            problems.push(`${where}: link to ${file} — no such file`)
            continue
          }
          if (
            anchor &&
            destination.endsWith(".md") &&
            statSync(destination).isFile() &&
            !anchors(destination).has(anchor)
          )
            problems.push(`${where}: link to ${file}#${anchor} — no such heading`)
        }
      })
  }
  return problems
}

const problems = [...changelogProblems(readFileSync(join(root, "CHANGELOG.md"), "utf8")), ...linkProblems()]
for (const problem of problems) console.error(problem)
if (problems.length > 0) process.exit(1)
console.log("docs: ok")
