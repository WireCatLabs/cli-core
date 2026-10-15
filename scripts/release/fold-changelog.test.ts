import { describe, expect, it } from "vitest"
import { foldUnreleased } from "./fold-changelog.ts"

const changelog = `# Changelog

Intro.

## Unreleased

### Added

- New thing.

### Fixed

- Newer fix.

## 0.9.0 — 14.10.2026

### Fixed

- Older fix.

## 0.8.0 — 01.10.2026

### Added

- Old thing.
`

describe("foldUnreleased", () => {
  it("merges Unreleased into the dated version below it, same headings together, newest first", () => {
    expect(foldUnreleased(changelog, "0.9.0")).toBe(`# Changelog

Intro.

## 0.9.0 — 14.10.2026

### Added

- New thing.

### Fixed

- Newer fix.
- Older fix.

## 0.8.0 — 01.10.2026

### Added

- Old thing.
`)
  })

  it("leaves the changelog alone when the section below Unreleased is another version", () => {
    expect(foldUnreleased(changelog, "0.10.0")).toBeUndefined()
  })

  it("leaves the changelog alone when the top section is already dated", () => {
    expect(foldUnreleased(changelog.replace("## Unreleased", "## 0.10.0 — 15.10.2026"), "0.10.0")).toBeUndefined()
  })

  it("drops an empty Unreleased", () => {
    const empty = "# Changelog\n\n## Unreleased\n\n## 0.9.0 — 14.10.2026\n\n### Fixed\n\n- Older fix.\n"
    expect(foldUnreleased(empty, "0.9.0")).toBe("# Changelog\n\n## 0.9.0 — 14.10.2026\n\n### Fixed\n\n- Older fix.\n")
  })

  it("refuses text under Unreleased that has no heading, rather than losing it", () => {
    const loose = changelog.replace("## Unreleased\n", "## Unreleased\n\nA stray line.\n")
    expect(() => foldUnreleased(loose, "0.9.0")).toThrow(/before its first ### heading/)
  })
})
