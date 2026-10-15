/**
 * Folds `## Unreleased` into the section below it when that section is the package version, dated but
 * not on npm yet. One session dates the version and another adds Unreleased above it before anyone
 * publishes; this happened three times on 2026-10-15 and each needed a hand fold (#1296).
 *
 *   node --experimental-strip-types scripts/release/fold-changelog.ts <CHANGELOG.md> <version>
 *
 * Writes the file and prints a line when it folded; prints nothing when there is nothing to fold.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

type Section = { title: string; headings: Map<string, string[]> }

const parseSection = (block: string): Section => {
  const [title = "", ...lines] = block.split("\n")
  const headings = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of lines) {
    if (line.startsWith("### ")) {
      current = headings.get(line.slice(4)) ?? []
      headings.set(line.slice(4), current)
    } else if (current) current.push(line)
    else if (line.trim()) throw new Error(`"${title}" has text before its first ### heading: "${line}"`)
  }
  for (const [heading, body] of headings) headings.set(heading, trimBlank(body))
  return { title, headings }
}

const trimBlank = (lines: string[]) => {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start]?.trim()) start++
  while (end > start && !lines[end - 1]?.trim()) end--
  return lines.slice(start, end)
}

/** The folded changelog, or `undefined` when the top is not Unreleased above `## <version> — `. */
export const foldUnreleased = (text: string, version: string): string | undefined => {
  const blocks = text.split(/\n(?=## )/)
  const [preamble, top, next, ...rest] = blocks
  if (top !== "## Unreleased" && !top?.startsWith("## Unreleased\n")) return undefined
  if (!next?.startsWith(`## ${version} — `)) return undefined
  const unreleased = parseSection(top)
  const dated = parseSection(next)
  const merged = new Map<string, string[]>()
  for (const section of [unreleased, dated])
    for (const [heading, body] of section.headings) merged.set(heading, [...(merged.get(heading) ?? []), ...body])
  const body = [...merged]
    .filter(([, lines]) => lines.length > 0)
    .map(([heading, lines]) => `### ${heading}\n\n${lines.join("\n")}\n`)
    .join("\n")
  const folded = `${dated.title}\n\n${body}`
  return [preamble, folded, ...rest].join("\n")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, version] = process.argv.slice(2)
  if (!file || !version) {
    console.error("usage: fold-changelog.ts <CHANGELOG.md> <version>")
    process.exit(2)
  }
  const folded = foldUnreleased(readFileSync(file, "utf8"), version)
  if (folded !== undefined) {
    writeFileSync(file, folded)
    console.log(`folded Unreleased into ${version}`)
  }
}
