/**
 * Writes docs/reasons.md's table from `REASONS`, the error reasons cli-core raises (`CORE_REASONS`). The committed page
 * is the contract: a reason it lists that `REASONS` no longer has, or has under another code, breaks callers that
 * match on it, so neither mode drops that row until a changes/ fragment names the reason under a break heading.
 *
 *   pnpm reasons:docs                        write the table (after pnpm build)
 *   node scripts/reasons-docs.ts --check     fail when the page and REASONS disagree (in docs:check)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { type Fragment, readFragments } from "./changelog-fragments.ts"
import { cell, withGenerated } from "./generated-blocks.ts"

export type Reason = { reason: string; code: string; message: string; details?: readonly string[] }

const BREAKS = ["Changed — may break callers", "Removed"]
const BLOCK = "reasons"
const ROW = /^\| `([^`]+)` \| `([^`]+)` \|/

export const documented = (text: string): Map<string, string> => {
  const start = text.indexOf(`<!-- ${BLOCK}: generated -->`)
  const end = text.indexOf(`<!-- ${BLOCK}: end -->`)
  const rows = new Map<string, string>()
  for (const line of text.slice(start, end).split("\n")) {
    const found = ROW.exec(line)
    if (found?.[1] && found[2]) rows.set(found[1], found[2])
  }
  return rows
}

const announced = (fragments: Fragment[]): Set<string> => {
  const names = new Set<string>()
  for (const { text } of fragments) {
    let heading = ""
    for (const line of text.split("\n")) {
      if (line.startsWith("### ")) heading = line.slice(4).trim()
      else if (BREAKS.includes(heading)) for (const [, name] of line.matchAll(/`([^`\s]+)`/g)) names.add(name ?? "")
    }
  }
  return names
}

/** The documented reasons that are gone or recoded without a fragment saying so. */
export const breakProblems = (rows: Map<string, string>, reasons: readonly Reason[], fragments: Fragment[]) => {
  const now = new Map(reasons.map((entry) => [entry.reason, entry.code]))
  const told = announced(fragments)
  const problems: string[] = []
  for (const [reason, code] of rows) {
    if (told.has(reason)) continue
    const current = now.get(reason)
    if (current === undefined)
      problems.push(`\`${reason}\` is gone from REASONS: removing or renaming a reason breaks callers`)
    else if (current !== code) problems.push(`\`${reason}\` changed its code from ${code} to ${current}`)
  }
  return problems.map(
    (problem) =>
      `${problem}. Name it in a changes/ fragment under "${BREAKS.join('" or "')}", then run pnpm reasons:docs`,
  )
}

export const reasonsTable = (reasons: readonly Reason[]): string => {
  const rows = [...reasons]
    .sort((a, b) => (a.reason < b.reason ? -1 : 1))
    .map((entry) => {
      const details = (entry.details ?? []).map((key) => `\`${key}\``).join(", ")
      return `| \`${entry.reason}\` | \`${entry.code}\` | ${cell(entry.message)} | ${details} |`
    })
  return ["| Reason | Code | Meaning | Details |", "|---|---|---|---|", ...rows].join("\n")
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "..")
  const page = join(root, "docs/reasons.md")
  const { REASONS } = (await import(pathToFileURL(join(root, "dist/errors/reasons.js")).href)) as { REASONS: Reason[] }
  const text = readFileSync(page, "utf8")
  const problems = breakProblems(documented(text), REASONS, readFragments(root))
  const result = withGenerated(text, [[BLOCK, reasonsTable(REASONS)]])
  if (process.argv.includes("--check") && result !== text)
    problems.push("docs/reasons.md drifts from REASONS in src/errors/reasons.ts — run pnpm reasons:docs")
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exit(1)
  }
  if (!process.argv.includes("--check")) writeFileSync(page, result)
}
