import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

/** The prefixes of the owner's journal ids; a project adds its own (`CLI`, `MAX`, …). */
export const JOURNAL_IDS = ["NEED", "FIND", "BUG", "SEC", "PERF", "UX", "IDEA", "RISK", "DEBT", "ASK", "TASK"] as const

export const idPattern = (prefixes: readonly string[]) => new RegExp(`\\b(?:${prefixes.join("|")})-\\d+\\b`, "g")

const VERSION_HEADING = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) — (\d{2})\.(\d{2})\.(\d{4})$/

export type ChangelogRules = {
  /** The only `###` headings a section may have. */
  headings: readonly string[]
  /** The top section's title until it is dated, `Unreleased` or `Не выпущено`. */
  unreleased: string
  ids: readonly string[]
}

/**
 * `release`: the top section must be `version`, and nothing may be left unreleased — a release
 * workflow builds its notes by matching `## <version> `, so a heading slightly off publishes empty
 * notes without an error.
 */
export const changelogProblems = (
  text: string,
  { version, release, headings, unreleased, ids }: ChangelogRules & { version?: string; release: boolean },
) => {
  const problems: string[] = []
  const id = idPattern(ids)
  let section: string | undefined
  let subheadings = new Set<string>()
  let first = true

  text.split("\n").forEach((line, index) => {
    const where = `CHANGELOG.md:${index + 1}`
    if (line.startsWith("## ")) {
      section = line.slice(3)
      subheadings = new Set()
      if (section === unreleased) {
        if (release) problems.push(`${where}: "${unreleased}" is left — date it as ${version} before releasing`)
        else if (!first) problems.push(`${where}: "${unreleased}" must be the top section`)
      } else {
        const found = VERSION_HEADING.exec(line)
        if (!found) problems.push(`${where}: "${line}" is not "## <version> — DD.MM.YYYY"`)
        else {
          const [, heading, day, month] = found
          if (Number(day) < 1 || Number(day) > 31 || Number(month) < 1 || Number(month) > 12)
            problems.push(`${where}: "${line}" has no such date`)
          if (release && first && heading !== version)
            problems.push(`${where}: the top section is ${heading}, package.json says ${version}`)
        }
      }
      first = false
      return
    }
    if (line.startsWith("### ")) {
      const heading = line.slice(4)
      if (!headings.includes(heading)) problems.push(`${where}: "${heading}" is not one of: ${headings.join(", ")}`)
      if (subheadings.has(heading)) problems.push(`${where}: "${heading}" twice in "${section}"`)
      subheadings.add(heading)
    }
    for (const found of line.match(id) ?? []) problems.push(`${where}: internal id ${found} — say what changed instead`)
  })

  if (release && first) problems.push(`CHANGELOG.md: no section for ${version}`)
  return problems
}

/** GitHub's heading anchor: lower case, only letters, digits, `-`, `_` and spaces kept, spaces to `-`. */
export const slug = (heading: string) =>
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

/** Every `.md` under `directory`, not descending into a directory named in `skip`. */
export const markdownFiles = (directory: string, skip: ReadonlySet<string> = new Set()): string[] =>
  existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (skip.has(entry.name)) return []
        const path = join(directory, entry.name)
        if (entry.isDirectory()) return markdownFiles(path, skip)
        return entry.name.endsWith(".md") ? [path] : []
      })
    : []

export type DocsRules = {
  /** Absolute paths; a missing one is passed over. */
  files: readonly string[]
  ids: readonly string[]
  /** A page a user reads, by its path relative to `root`: no correction mark, struck-out text or id. */
  userPage?: (name: string) => boolean
  correction?: RegExp
  /** A link not to follow — a private or sibling checkout that CI does not have. */
  skipLink?: (target: string, destination: string) => boolean
}

export const docsProblems = (
  root: string,
  { files, ids, userPage = () => false, correction = /correction \d{4}/i, skipLink = () => false }: DocsRules,
) => {
  const id = idPattern(ids)
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
  for (const path of files.filter((file) => existsSync(file))) {
    const name = relative(root, path)
    const user = userPage(name)
    withoutCode(readFileSync(path, "utf8"))
      .split("\n")
      .forEach((line, index) => {
        const where = `${name}:${index + 1}`
        for (const [, target] of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
          if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
          const [file = "", anchor] = decodeURIComponent(target).split("#")
          const destination = file === "" ? path : resolve(dirname(path), file)
          if (skipLink(file, destination)) continue
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

        if (!user) return
        if (correction.test(line)) problems.push(`${where}: a correction mark on a user page`)
        if (line.includes("~~")) problems.push(`${where}: struck-out text on a user page`)
        for (const found of line.match(id) ?? []) problems.push(`${where}: internal id ${found} on a user page`)
      })
  }
  return problems
}
