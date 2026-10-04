import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  changelogProblems,
  command,
  docsProblems,
  JOURNAL_IDS,
  markdownFiles,
  packContents,
  packProblems,
  releaseCheck,
  slug,
  structureProblems,
  versionScript,
} from "./index.js"

const rules = {
  headings: ["Что нового", "Исправлено"],
  unreleased: "Не выпущено",
  ids: [...JOURNAL_IDS, "CLI", "MAX"],
}

const released = `# Изменения

## 0.19.0 — 29.09.2026

### Что нового

- **Новое.** Текст.

### Исправлено

- Ошибка.

## 0.18.1 — 28.09.2026

### Исправлено

- Другая.
`

describe("releaseCheck", () => {
  it("runs every check after a failure and prints one line each, then the count", () => {
    const lines: string[] = []
    const failed = releaseCheck(
      [
        { name: "lint", run: () => ["a.ts:1: bad\nsecond line"] },
        { name: "test", run: () => [] },
      ],
      { version: "1.2.3", log: (line) => lines.push(line) },
    )
    expect(failed).toBe(1)
    expect(lines).toEqual([
      "FAIL  lint",
      "      a.ts:1: bad\n      second line",
      "ok    test",
      "\n1.2.3: 1 check(s) failed",
    ])
  })

  it("says every check passed", () => {
    const lines: string[] = []
    expect(releaseCheck([{ name: "x", run: () => [] }], { version: "1.0.0", log: (line) => lines.push(line) })).toBe(0)
    expect(lines.at(-1)).toBe("\n1.0.0: every check passed")
  })
})

describe("command", () => {
  it("passes on exit 0 and shows the tail of the output otherwise", () => {
    expect(command(tmpdir(), "node", "-e", "")()).toEqual([])
    const [problem] = command(tmpdir(), "node", "-e", "for (let i = 1; i <= 20; i++) console.log(i); process.exit(3)")()
    expect(problem?.split("\n")).toEqual(Array.from({ length: 15 }, (_, i) => String(i + 6)))
  })
})

describe("changelogProblems", () => {
  it("passes a released top section", () => {
    expect(changelogProblems(released, { ...rules, version: "0.19.0", release: true })).toEqual([])
  })

  it("refuses an unreleased section at release, and allows it on a pull request", () => {
    const unreleased = released.replace("## 0.19.0 — 29.09.2026", "## Не выпущено")
    expect(changelogProblems(unreleased, { ...rules, version: "0.19.0", release: true })).toEqual([
      'CHANGELOG.md:3: "Не выпущено" is left — date it as 0.19.0 before releasing',
    ])
    expect(changelogProblems(unreleased, { ...rules, release: false })).toEqual([])
  })

  it("refuses a heading the release notes would not match", () => {
    const [problem] = changelogProblems(released.replace("0.19.0 — 29.09.2026", "0.19.0 - 29.09.2026"), {
      ...rules,
      version: "0.19.0",
      release: true,
    })
    expect(problem).toBe('CHANGELOG.md:3: "## 0.19.0 - 29.09.2026" is not "## <version> — DD.MM.YYYY"')
  })

  it("refuses a top section for another version, and no section at all", () => {
    expect(changelogProblems(released, { ...rules, version: "0.19.1", release: true })).toEqual([
      "CHANGELOG.md:3: the top section is 0.19.0, package.json says 0.19.1",
    ])
    expect(changelogProblems("# Изменения\n", { ...rules, version: "0.1.0", release: true })).toEqual([
      "CHANGELOG.md: no section for 0.1.0",
    ])
  })

  it("refuses a heading outside the fixed set, one used twice, and a date that does not exist", () => {
    const text = released
      .replace("### Исправлено\n\n- Ошибка.", "### Что исправлено\n\n- Ошибка.\n\n### Что нового")
      .replace("28.09.2026", "31.13.2026")
    expect(changelogProblems(text, { ...rules, version: "0.19.0", release: true })).toEqual([
      'CHANGELOG.md:9: "Что исправлено" is not one of: Что нового, Исправлено',
      'CHANGELOG.md:13: "Что нового" twice in "0.19.0 — 29.09.2026"',
      'CHANGELOG.md:15: "## 0.18.1 — 31.13.2026" has no such date',
    ])
  })

  it("refuses an unreleased section below the top", () => {
    const text = released.replace("## 0.18.1 — 28.09.2026", "## Не выпущено")
    expect(changelogProblems(text, { ...rules, release: false })).toEqual([
      'CHANGELOG.md:13: "Не выпущено" must be the top section',
    ])
  })

  it("refuses an internal id but not UTF-8 or ISO-8601", () => {
    const text = released.replace("Текст.", "Текст в UTF-8, время в ISO-8601 (CLI-57).")
    expect(changelogProblems(text, { ...rules, version: "0.19.0", release: true })).toEqual([
      "CHANGELOG.md:7: internal id CLI-57 — say what changed instead",
    ])
  })
})

describe("packProblems", () => {
  it("allows the listed files and directories, and names anything else", () => {
    expect(
      packProblems(
        ["dist/bin/max.js", "package.json", "README.md", "skills/max-cli/SKILL.md", "src/testing/fixtures/a.json"],
        ["dist/", "package.json", "README.md", "skills/max-cli/SKILL.md"],
        "dist/, package.json, README.md and the agent skill",
      ),
    ).toEqual([
      "npm pack: src/testing/fixtures/a.json would ship — only dist/, package.json, README.md and the agent skill may",
    ])
  })
})

describe("packContents", () => {
  it("reads what npm would pack", () => {
    const root = mkdtempSync(join(tmpdir(), "pack-"))
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pack-me", version: "1.0.0" }))
    writeFileSync(join(root, "stray.txt"), "")
    try {
      expect(packContents(root, ["package.json"], "package.json")()).toEqual([
        "npm pack: stray.txt would ship — only package.json may",
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("slug", () => {
  it("makes GitHub's anchor from a Russian heading with code in it", () => {
    expect(slug("Новые сообщения сразу: `max serve` и `max watch`")).toBe("новые-сообщения-сразу-max-serve-и-max-watch")
    expect(slug("Команды и чаты по `@`")).toBe("команды-и-чаты-по-")
  })
})

describe("markdownFiles", () => {
  it.skipIf(process.platform === "win32")("lists files and links, not a special file with a .md name", () => {
    const root = mkdtempSync(join(tmpdir(), "markdown-files-"))
    writeFileSync(join(root, "README.md"), "# x\n")
    symlinkSync(join(root, "README.md"), join(root, "linked.md"))
    execFileSync("mkfifo", [join(root, "loop.md")])

    expect(markdownFiles(root).sort()).toEqual([join(root, "README.md"), join(root, "linked.md")])
    rmSync(root, { recursive: true, force: true })
  })
})

describe("docsProblems", () => {
  let root: string
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const check = () =>
    docsProblems(root, {
      files: [join(root, "README.md"), ...markdownFiles(join(root, "docs"))],
      ids: rules.ids,
      userPage: (name) => name === "README.md" || /^docs\/[^/]+\.md$/.test(name),
      correction: /поправка|correction \d{4}/i,
      skipLink: (target) => /(^|\/)docs_ai(\/|$)/.test(target),
    })
  const fixture = (usage: string) => {
    root = mkdtempSync(join(tmpdir(), "docs-check-"))
    write("README.md", "# max\n\n[Использование](docs/usage.md#вход) и [приватное](docs_ai/HANDOFF.md).\n")
    write("docs/usage.md", usage)
    write("docs/dev/notes.md", '# Notes\n\n<a name="old"></a>\n\n~~old~~ **Correction 2026-09-28:** new, `CLI-5`.\n')
  }
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("passes working links and named anchors, and allows corrections on developer pages", () => {
    fixture("# Использование\n\n## Вход\n\n[old](dev/notes.md#old)\n\n```sh\n~~ [x](nowhere.md) CLI-1\n```\n")
    expect(check()).toEqual([])
  })

  it("names a dead link and a dead anchor", () => {
    fixture("# Использование\n\n## Выход\n\n[см.](missing.md) и [там](#нет)\n")
    expect(check()).toEqual([
      "README.md:3: link to docs/usage.md#вход — no such heading",
      "docs/usage.md:5: link to missing.md — no such file",
      "docs/usage.md:5: link to #нет — no such heading",
    ])
  })

  it("refuses a correction mark, struck-out text and an id on a user page", () => {
    fixture("# Использование\n\n## Вход\n\n**Поправка:** ~~было~~ стало (MAX-4).\n")
    expect(check()).toEqual([
      "docs/usage.md:5: a correction mark on a user page",
      "docs/usage.md:5: struck-out text on a user page",
      "docs/usage.md:5: internal id MAX-4 on a user page",
    ])
  })
})

describe("versionScript", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "version-"))
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.0" }))
    writeFileSync(join(root, "src/version.ts"), 'export const VERSION = "1.1.0"\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("fails on drift, and --sync writes package.json's version into the source", () => {
    expect(versionScript(root, [])).toEqual({
      code: 1,
      message: expect.stringMatching(/^version drift: package.json says 1.2.0, src\/version.ts says 1.1.0\./),
    })
    expect(versionScript(root, ["--sync"])).toEqual({ code: 0, message: "src/version.ts: 1.1.0 → 1.2.0" })
    expect(readFileSync(join(root, "src/version.ts"), "utf8")).toBe('export const VERSION = "1.2.0"\n')
    expect(versionScript(root, [])).toEqual({
      code: 0,
      message: "version 1.2.0 — package.json and src/version.ts agree",
    })
    expect(versionScript(root, ["--sync"])).toEqual({ code: 0, message: "version 1.2.0 — already in step" })
  })

  it("exits 2 when either file has no version", () => {
    writeFileSync(join(root, "src/version.ts"), "export const OTHER = 1\n")
    expect(versionScript(root, [])).toEqual({ code: 2, message: "src/version.ts does not export a VERSION string" })
    writeFileSync(join(root, "package.json"), "{}")
    expect(versionScript(root, [])).toEqual({
      code: 2,
      message: 'package.json has no usable "version" (got undefined)',
    })
  })
})

describe("structureProblems", () => {
  let root: string
  const write = (name: string, text: string) => {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), text)
  }
  const meta = (value: unknown) => write("docs/meta.json", JSON.stringify(value))

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "structure-"))
    write("docs/README.md", "# For contributors\n")
    write("docs/index.md", "# tool\n\n```sh\n# a comment, not a heading\n```\n")
    write("docs/usage.md", "<!-- generated -->\n\n# Usage\n\n## Reading\n")
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("passes listed pages, separators, links and the changelog from the root", () => {
    meta({ title: "tool", pages: ["---Start---", "index", "usage", "[GitHub](https://github.com)", "changelog"] })
    expect(structureProblems(root, { required: ["index"] })).toEqual([])
  })

  it("names a missing meta.json, and one that is not JSON", () => {
    expect(structureProblems(root)).toEqual(["docs/meta.json: missing — it lists the pages in sidebar order"])
    write("docs/meta.json", "{")
    expect(structureProblems(root)[0]).toMatch(/^docs\/meta\.json: not JSON/)
  })

  it("names a listed page with no file, an unlisted file, a duplicate, a required page and a foreign key", () => {
    meta({ title: "tool", lang: "en", pages: ["index", "index", "ghost"] })
    expect(structureProblems(root, { required: ["index", "security"] })).toEqual([
      'docs/meta.json: "lang" is not a Fumadocs key',
      'docs/meta.json: "index" is listed twice',
      'docs/meta.json: "ghost" — no docs/ghost.md',
      'docs/meta.json: "security" is required and not listed',
      "docs/usage.md: not in meta.json — listed nowhere, so the portal never shows it",
    ])
  })

  it("wants exactly one title heading, first on the page", () => {
    meta({ pages: ["index", "usage", "late", "twice"] })
    write("docs/late.md", "Some text.\n\n# Late\n")
    write("docs/twice.md", "# One\n\n# Two\n")
    expect(structureProblems(root, { required: [] })).toEqual([
      'docs/late.md: the "# " heading must come first',
      'docs/twice.md: 2 "# " headings — a page has exactly one, its title',
    ])
  })
})
