import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const script = fileURLToPath(new URL("./ci-fingerprint.sh", import.meta.url))
const packageJson = `{
  "name": "@wirecat/example",
  "version": "1.2.3",
  "dependencies": {
    "left-pad": "1.3.0"
  }
}
`

describe("ci-fingerprint.sh", () => {
  let repo: string
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim()
  const fingerprint = (rev = "HEAD", ...flags: string[]) =>
    execFileSync("bash", [script, ...flags, rev], { cwd: repo, env, encoding: "utf8" }).trim()
  const edit = (file: string, change: (text: string) => string) => {
    const path = join(repo, file)
    writeFileSync(path, change(readFileSync(path, "utf8")))
    git("commit", "-qam", `edit ${file}`)
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ci-fingerprint-"))
    git("init", "-q")
    writeFileSync(join(repo, "package.json"), packageJson)
    writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n- a change\n")
    writeFileSync(join(repo, "index.ts"), "export const answer = 42\n")
    git("add", ".")
    git("commit", "-qm", "base")
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it("stays the same when only the version and the changelog change", () => {
    const before = fingerprint()
    edit("package.json", (text) => text.replace('"version": "1.2.3"', '"version": "1.3.0"'))
    edit("CHANGELOG.md", (text) => text.replace("## Unreleased", "## 1.3.0 — 2026-10-26"))
    expect(fingerprint()).toBe(before)
  })

  it("stays the same when the release collects and deletes the changelog fragments", () => {
    mkdirSync(join(repo, "changes"))
    writeFileSync(join(repo, "changes", "fix-a.md"), "### Fixed\n\n- a fix\n")
    git("add", ".")
    git("commit", "-qm", "fragment")
    const before = fingerprint()
    git("rm", "-q", "changes/fix-a.md")
    edit("CHANGELOG.md", (text) => text.replace("## Unreleased", "## 1.3.0 — 2026-10-26\n\n### Fixed\n\n- a fix"))
    expect(fingerprint()).toBe(before)
  })

  it("changes with one line of source", () => {
    const before = fingerprint()
    edit("index.ts", (text) => text.replace("42", "43"))
    expect(fingerprint()).not.toBe(before)
  })

  it("changes with a dependency bump in package.json", () => {
    const before = fingerprint()
    edit("package.json", (text) => text.replace('"left-pad": "1.3.0"', '"left-pad": "1.3.1"'))
    expect(fingerprint()).not.toBe(before)
  })

  describe("with --docs", () => {
    const add = (file: string, text: string) => {
      mkdirSync(join(repo, file, ".."), { recursive: true })
      writeFileSync(join(repo, file), text)
      git("add", ".")
      git("commit", "-qm", `add ${file}`)
    }
    const docs = () => fingerprint("HEAD", "--docs")

    beforeEach(() => {
      add("README.md", "# Example\n")
      add("docs/dev/plans/plan.md", "# Plan\n")
      add("docs/search/recipes.json", "[]\n")
      add("skills/example/SKILL.md", "# Skill\n")
    })

    it("stays the same when only Markdown under docs/ or at the top level changes", () => {
      const [before, plain] = [docs(), fingerprint()]
      edit("README.md", (text) => `${text}More.\n`)
      edit("docs/dev/plans/plan.md", (text) => `${text}More.\n`)
      add("docs/new.md", "# New\n")
      expect(docs()).toBe(before)
      expect(fingerprint()).not.toBe(plain)
    })

    it("changes with a file under docs/ that the package ships", () => {
      const before = docs()
      edit("docs/search/recipes.json", () => "[1]\n")
      expect(docs()).not.toBe(before)
    })

    it("changes with a skill, which the package ships and the code reads", () => {
      const before = docs()
      edit("skills/example/SKILL.md", (text) => `${text}More.\n`)
      expect(docs()).not.toBe(before)
    })
  })

  it("refuses a package.json without exactly one top-level version", () => {
    edit("package.json", (text) => text.replace('  "version": "1.2.3",\n', ""))
    expect(() => execFileSync("bash", [script], { cwd: repo, env, stdio: "pipe" })).toThrow()
  })
})
