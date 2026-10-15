/**
 * Every relative link and anchor in every document resolves, and the changelog has its shape — on
 * every pull request, so a stale link fails the change that made it. Adapted from max-cli's
 * `scripts/docs-check.ts` and `scripts/release/checks.ts`.
 *
 *   pnpm docs:check
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { changelogProblems, taggedVersions } from "./changelog-shape.ts"

const SKIPPED = new Set(["node_modules", "dist", "coverage", ".git", ".worktrees", "docs_ai"])

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

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
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : markdownFiles(path)
    return entry.name.endsWith(".md") ? [path] : []
  })

const linkProblems = (base: string): string[] => {
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
  for (const path of markdownFiles(base)) {
    const name = relative(base, path)
    withoutCode(readFileSync(path, "utf8"))
      .split("\n")
      .forEach((line, index) => {
        const where = `${name}:${index + 1}`
        for (const [, target] of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
          if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
          const [file = "", anchor] = decodeURIComponent(target).split("#")
          const destination = file === "" ? path : resolve(dirname(path), file)
          // A sibling checkout exists on one machine and nowhere else — not in CI, not on GitHub.
          if (destination !== base && !destination.startsWith(base + sep)) {
            problems.push(`${where}: link to ${file} leaves the repository — use its GitHub URL`)
            continue
          }
          if (/(^|\/)docs_ai(\/|$)/.test(relative(base, destination))) continue
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

const problems = [
  ...changelogProblems(readFileSync(join(root, "CHANGELOG.md"), "utf8"), taggedVersions(root)),
  ...linkProblems(root),
]
for (const problem of problems) console.error(problem)
if (problems.length > 0) process.exit(1)
console.log("docs: ok")
