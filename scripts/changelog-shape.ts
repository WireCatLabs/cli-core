import { execFileSync } from "node:child_process"

const HEADINGS = ["Added", "Changed — may break callers", "Fixed", "Security", "Removed"]
const UNRELEASED = "Unreleased"
const VERSION_HEADING = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) — (\d{2})\.(\d{2})\.(\d{4})$/
const ID = /\b(?:CLI|MAX|OPS|CORE|NEED|BUG|FIND|SEC|PERF|UX|IDEA|DEBT|RISK|ASK|TASK)-\d+\b/g

/**
 * Versions tagged `v<version>`, as the changelog guard reads them. CI checks out without tags, so an
 * empty local list falls back to the remote's; if that fails too, every section is checked.
 */
export const taggedVersions = (cwd: string): Set<string> => {
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    } catch {
      return ""
    }
  }
  const local = git("tag", "--list", "v*").split("\n").filter(Boolean)
  const tags =
    local.length > 0
      ? local
      : git("ls-remote", "--tags", "--refs", "origin", "v*")
          .split("\n")
          .map((line) => line.split("refs/tags/")[1] ?? "")
          .filter(Boolean)
  return new Set(tags.map((tag) => tag.replace(/^v/, "")))
}

// A tagged section is published history the changelog guard refuses to edit, so a flaw in its
// subheadings can no longer be fixed and must not block every later release.
export const changelogProblems = (text: string, tagged: Set<string>): string[] => {
  const problems: string[] = []
  const versions = new Set<string>()
  let section = ""
  let released = false
  let subheadings = new Set<string>()
  let first = true
  text.split("\n").forEach((line, index) => {
    const where = `CHANGELOG.md:${index + 1}`
    if (line.startsWith("## ")) {
      section = line.slice(3)
      subheadings = new Set()
      released = false
      if (section === UNRELEASED) {
        if (!first) problems.push(`${where}: «${UNRELEASED}» must be the top section`)
      } else {
        const found = VERSION_HEADING.exec(line)
        if (!found) problems.push(`${where}: "${line}" is not "## <version> — DD.MM.YYYY"`)
        else {
          if (Number(found[2]) < 1 || Number(found[2]) > 31 || Number(found[3]) < 1 || Number(found[3]) > 12)
            problems.push(`${where}: "${line}" has no such date`)
          if (versions.has(found[1] ?? "")) problems.push(`${where}: version ${found[1]} twice`)
          versions.add(found[1] ?? "")
          released = tagged.has(found[1] ?? "")
        }
      }
      first = false
      return
    }
    if (line.startsWith("### ") && !released) {
      const heading = line.slice(4)
      if (!HEADINGS.includes(heading)) problems.push(`${where}: "${heading}" is not one of: ${HEADINGS.join(", ")}`)
      if (subheadings.has(heading)) problems.push(`${where}: "${heading}" twice in "${section}"`)
      subheadings.add(heading)
    }
    if (!released)
      for (const id of line.match(ID) ?? []) problems.push(`${where}: internal id ${id} — say what changed instead`)
  })
  return problems
}
