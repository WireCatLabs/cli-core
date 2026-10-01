import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { type DevIo, main } from "./main.js"

let root: string
let out: string[]
let err: string[]
let io: DevIo

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli-dev-"))
  out = []
  err = []
  io = { cwd: root, out: (text) => out.push(text), err: (text) => err.push(text) }
})

describe("next-version", () => {
  const next = async (...args: string[]) => ({ code: await main(["next-version", ...args], io), out, err })

  it("keeps the wanted version when npm has not taken it and it is above npm's latest", async () => {
    expect(await next("1.3.0", "1.2.4", '["1.2.4"]')).toMatchObject({ code: 0, out: ["1.3.0"] })
  })

  it("takes the next free minor for an x.y.0 and the next free patch otherwise", async () => {
    expect((await next("1.2.0", "1.2.0", '["1.2.0","1.3.0"]')).out).toEqual(["1.4.0"])
    out.length = 0
    expect((await next("1.2.1", "1.2.3", '["1.2.3","1.2.4"]')).out).toEqual(["1.2.5"])
  })

  it("passes a pre-release through, and a first publish when npm knows nothing", async () => {
    expect((await next("2.0.0-rc.1", "1.0.0", "")).out).toEqual(["2.0.0-rc.1"])
    out.length = 0
    expect((await next("0.1.0", "", "not json")).out).toEqual(["0.1.0"])
  })

  it("refuses a taken version when npm's latest is not plain x.y.z", async () => {
    const result = await next("1.0.0", "1.1.0-beta", '"1.0.0"')
    expect(result.code).toBe(1)
    expect(result.err[0]).toContain("1.0.0 is on npm")
  })
})

describe("slow-tests", () => {
  it("lists the slowest tests and files from vitest's JSON report, paths relative to the repository", async () => {
    write(
      "coverage/tests.json",
      JSON.stringify({
        testResults: [
          {
            name: join(root, "src/a.test.ts"),
            startTime: 0,
            endTime: 300,
            assertionResults: [{ title: "fast", duration: 5 }, { title: "slow", duration: 250 }, { title: "none" }],
          },
          { name: join(root, "src/b.test.ts"), startTime: 0, endTime: 900, assertionResults: [] },
        ],
      }),
    )
    expect(await main(["slow-tests", "coverage/tests.json", "2"], io)).toBe(0)
    expect(out[0]).toBe(
      [
        "3 tests, 0.3 s of test time",
        "",
        "slowest tests:",
        "   250 ms  src/a.test.ts  slow",
        "     5 ms  src/a.test.ts  fast",
        "",
        "slowest files:",
        "   900 ms  src/b.test.ts",
        "   300 ms  src/a.test.ts",
      ].join("\n"),
    )
  })
})

describe("version", () => {
  beforeEach(() => {
    write("package.json", JSON.stringify({ version: "1.2.0" }))
    write("src/version.ts", 'export const VERSION = "1.1.0"\n')
  })

  it("fails on drift and writes package.json's version with --sync", async () => {
    expect(await main(["version"], io)).toBe(1)
    expect(err[0]).toContain("version drift")
    expect(await main(["version", "--sync"], io)).toBe(0)
    expect(readFileSync(join(root, "src/version.ts"), "utf8")).toBe('export const VERSION = "1.2.0"\n')
    expect(await main(["version"], io)).toBe(0)
  })

  it("reads another file with --file", async () => {
    write("lib/v.ts", 'export const VERSION = "1.2.0"\n')
    expect(await main(["version", "--file", "lib/v.ts"], io)).toBe(0)
    expect(out[0]).toContain("lib/v.ts agree")
  })
})

describe("docs-check", () => {
  const changelog = "# Changelog\n\n## Unreleased\n\n### Fixed\n\n- **A fix.** Text.\n"

  it("passes a repository whose links resolve, with the default English rules", async () => {
    write("CHANGELOG.md", changelog)
    write("README.md", "See [the changelog](CHANGELOG.md#unreleased).\n")
    write("docs_ai/notes.md", "[broken](nowhere.md)\n")
    expect(await main(["docs-check"], io)).toBe(0)
    expect(out).toEqual(["docs: ok"])
  })

  it("reports a broken anchor and an id in the changelog that --ids adds", async () => {
    write("CHANGELOG.md", `${changelog}- CLI-4 again\n`)
    write("README.md", "[gone](CHANGELOG.md#nothing)\n")
    expect(await main(["docs-check", "--ids", "CLI"], io)).toBe(1)
    expect(err).toEqual([
      "CHANGELOG.md:8: internal id CLI-4 — say what changed instead",
      "README.md:1: link to CHANGELOG.md#nothing — no such heading",
    ])
  })

  it("checks docs/ against docs/meta.json only with --pages", async () => {
    write("CHANGELOG.md", changelog)
    write("docs/index.md", "# Tool\n")
    expect(await main(["docs-check"], io)).toBe(0)
    expect(await main(["docs-check", "--pages"], io)).toBe(1)
    expect(err).toEqual(["docs/meta.json: missing — it lists the pages in sidebar order"])
  })

  it("takes a repository's own rules from a TypeScript module", async () => {
    write("CHANGELOG.md", "# Изменения\n\n## Не выпущено\n\n### Исправлено\n\n- Ошибка.\n")
    write("README.md", "Поправка 2026\n")
    write(
      "scripts/rules.ts",
      `export const CHANGELOG: { headings: string[]; unreleased: string; ids: string[] } = {
  headings: ["Исправлено"], unreleased: "Не выпущено", ids: ["NEED"] }
export const docsRules = (root: string) => ({
  files: [root + "/README.md"], ids: ["NEED"], userPage: () => true, correction: /поправка/i })
`,
    )
    expect(await main(["docs-check", "--rules", "scripts/rules.ts"], io)).toBe(1)
    expect(err).toEqual(["README.md:1: a correction mark on a user page"])
  })
})

describe("test-matrix", () => {
  const node = (name: string, parent: object | null, extra: object = {}) => ({
    name: () => name,
    parent,
    commands: [] as object[],
    options: [] as object[],
    ...extra,
  })

  beforeEach(() => {
    write(
      "dist/program.mjs",
      `const node = ${node.toString()}
export const createProgram = () => {
  const program = node("demo", null, { options: [{ long: "--json" }, { long: "--help" }, { long: "--quiet" }] })
  const send = node("send", program, { _actionHandler: () => {}, options: [{ long: "--to" }, { long: "--help" }, { short: "-n" }] })
  const group = node("chat", program)
  const list = node("list", group, { _actionHandler: () => {}, options: [{ long: "--limit" }] })
  const serve = node("serve", program, { _actionHandler: () => {}, options: [{ long: "--idle" }] })
  group.commands.push(list)
  program.commands.push(send, group, serve)
  return program
}
`,
    )
    write(
      "scripts/untested.ts",
      `export const UNTESTED: { command: string; option?: string; reason: string }[] = [
  { command: "serve", reason: "runs until stopped | live" },
  { command: "chat *", option: "--limit", reason: "live only" },
  { command: "", option: "--quiet", reason: "global, checked live" },
]
`,
    )
    write("coverage/argv.jsonl", `${JSON.stringify({ command: "send", options: ["--to", "--json"] })}\n\n`)
    mkdirSync(join(root, "docs/dev"), { recursive: true })
  })

  const args = ["test-matrix", "--program", "dist/program.mjs", "--untested", "scripts/untested.ts", "--name", "demo"]

  it("writes the page from the program and the argv log, and fails --check on what has neither", async () => {
    expect(await main([...args, "--check"], io)).toBe(1)
    const page = readFileSync(join(root, "docs/dev/test-matrix.md"), "utf8")
    expect(page).toContain("Every command and option of `demo`")
    expect(page).toContain("**3 ✅ · 4 ⛔ · 2 ❌** — 3 commands, 6 options.")
    expect(page).toContain("| `send` | `--to` | ✅ |  |")
    expect(page).toContain("| `serve` | `--idle` | ⛔ | runs until stopped \\| live |")
    expect(page).toContain("| *global* | `--json` | ✅ |  |")
    expect(err).toEqual([
      "2 commands or options with no test and no reason — see docs/dev/test-matrix.md:",
      "  send -n",
      "  chat list",
      "test matrix: 3 tested, 4 untested with a reason, 2 missing",
    ])
  })

  it("passes without --check, and fails on an untested entry that names nothing", async () => {
    expect(await main(args, io)).toBe(0)
    // Another path: import() caches a module by its URL.
    write(
      "scripts/untested2.ts",
      `export const UNTESTED = [{ command: "gone", reason: "removed" }, { command: "serve", reason: "live" }]\n`,
    )
    err.length = 0
    expect(await main([...args.slice(0, 4), "scripts/untested2.ts", "--name", "demo"], io)).toBe(1)
    expect(err.slice(0, 2)).toEqual(["untested entries that name nothing in the program any more:", "  gone"])
  })

  it("refuses to run without the argv log or without its flags", async () => {
    expect(await main(["test-matrix"], io)).toBe(2)
    rmSync(join(root, "coverage/argv.jsonl"))
    expect(await main(args, io)).toBe(1)
    expect(err.at(-1)).toContain("no coverage/argv.jsonl")
  })
})

describe("cli-dev", () => {
  it("prints its usage for help and refuses an unknown command", async () => {
    expect(await main(["help"], io)).toBe(0)
    expect(out[0]).toContain("usage: cli-dev")
    expect(await main(["nope"], io)).toBe(2)
    expect(await main([], io)).toBe(2)
    expect(err[0]).toContain('no command "nope"')
  })

  it("runs from the bin with the process's arguments, streams and exit code", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const argv = process.argv
    process.argv = ["node", "cli-dev", "next-version", "1.0.0", "", ""]
    try {
      await import("./bin.js")
      expect(write).toHaveBeenCalledWith("1.0.0\n")
      expect(process.exitCode).toBe(0)
    } finally {
      process.argv = argv
      process.exitCode = undefined
      write.mockRestore()
    }
  })
})
