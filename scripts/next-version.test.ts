import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
// @ts-expect-error a plain .mjs script, untyped
import { nextVersion } from "./next-version.mjs"

const repo = (changelog: string, fragments: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "next-version-"))
  writeFileSync(join(root, "CHANGELOG.md"), changelog)
  mkdirSync(join(root, "changes"))
  for (const [name, text] of Object.entries(fragments)) writeFileSync(join(root, "changes", name), text)
  return root
}

const released = (version: string) => `# Changelog\n\n## ${version} — 20.11.2026\n\n### Fixed\n\n- **A fix.**\n`
const fragment = (heading: string) => ({ "x.md": `### ${heading}\n\n- **Something.**\n` })

describe("nextVersion", () => {
  it("keeps the 0.x minor steps without a root, as ci.yml's version job calls it", async () => {
    expect(await nextVersion("0.736.0", "0.736.0", '["0.736.0"]')).toBe("0.737.0")
    expect(await nextVersion("0.737.0", "0.736.0", '["0.736.0"]')).toBe("0.737.0")
    expect(await nextVersion("1.0.0-rc.1", "0.736.0", '["0.736.0"]')).toBe("1.0.0-rc.1")
  })

  it("makes a break of the stable API after 1.0.0 a major, from the fragments", async () => {
    const root = repo(released("1.0.0"), fragment("Changed — may break callers"))
    expect(await nextVersion("1.0.0", "1.0.0", '["1.0.0"]', root)).toBe("2.0.0")
  })

  it("keeps a minor when the fragments add or fix only", async () => {
    expect(await nextVersion("1.0.0", "1.0.0", '["1.0.0"]', repo(released("1.0.0"), fragment("Fixed")))).toBe("1.1.0")
    expect(await nextVersion("1.0.0", "1.0.0", '["1.0.0"]', repo(released("1.0.0"), fragment("Added")))).toBe("1.1.0")
  })

  it("levels a section dated by hand with the fragments collected into it", async () => {
    const root = repo(`# Changelog\n\n## 1.1.0 — 23.11.2026\n\n${released("1.0.0").slice(13)}`, fragment("Removed"))
    expect(await nextVersion("1.1.0", "1.0.0", '["1.0.0"]', root)).toBe("2.0.0")
  })

  it("keeps a 0.x break a minor", async () => {
    const root = repo(released("0.736.0"), fragment("Changed — may break callers"))
    expect(await nextVersion("0.736.0", "0.736.0", '["0.736.0"]', root)).toBe("0.737.0")
  })
})
