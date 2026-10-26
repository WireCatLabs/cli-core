import { describe, expect, it } from "vitest"
import { changelogProblems } from "./changelog-shape.ts"

const changelog = (version: string) =>
  ["# Changelog", "", `## ${version} — 15.10.2026`, "", "### Fixed", "", "- a", "", "### Fixed", "", "- b", ""].join(
    "\n",
  )

describe("changelogProblems", () => {
  it("leaves a tagged section's subheadings alone, since the guard forbids editing it", () => {
    expect(changelogProblems(changelog("1.2.0"), new Set(["1.2.0"]))).toEqual([])
  })

  it("refuses a repeated subheading in a section not tagged yet", () => {
    expect(changelogProblems(changelog("1.2.0"), new Set(["1.1.0"]))).toEqual([
      'CHANGELOG.md:9: "Fixed" twice in "1.2.0 — 15.10.2026"',
    ])
  })

  it("still refuses a malformed or repeated version heading in tagged history", () => {
    const text = ["## 1.2.0 — 15.10.2026", "## 1.2.0 — 14.10.2026", "## 1.1 — 13.10.2026"].join("\n")
    expect(changelogProblems(text, new Set(["1.2.0", "1.1"]))).toEqual([
      "CHANGELOG.md:2: version 1.2.0 twice",
      'CHANGELOG.md:3: "## 1.1 — 13.10.2026" is not "## <version> — DD.MM.YYYY"',
    ])
  })
})
