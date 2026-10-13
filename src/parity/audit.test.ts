import type { CommandInfo } from "@wirecat/cli-base/commands"
import { describe, expect, it } from "vitest"
import { type AuditInput, allowFlags, type CliSide, ciRuns, pageSplit, renderAudit, split } from "./audit.js"
import type { CommandsJson, Manifest } from "./manifest.js"

const mcp = (flags: string[]): CommandInfo => ({
  path: ["mcp"],
  name: "mcp",
  description: "",
  usage: "",
  origin: "handwritten",
  arguments: [],
  options: flags.map((name) => ({ flags: name, description: "", takes_value: false, mandatory: false })),
  commands: [],
})

const program = (cli: string): CommandsJson => ({ cli, global_options: [], commands: [mcp(["--allow-send"])] })

const side = (cli: string, overrides: Partial<CliSide> = {}): CliSide => ({
  commit: "abc1234",
  pins: { "@wirecat/cli-core": "0.9.0" },
  program: program(cli),
  tools: [`${cli}_messages_send`],
  pages: {
    "README.md": "## One\n## Two\n",
    "docs/usage.md": "## a\n## b\n### c\n## d\n```sh\n## not one\n```\n",
    "docs/commands.md": "",
  },
  scripts: ["test"],
  skills: ["release"],
  ci: "run: pnpm parity:check node dist/bin/x.js commands --json | cli-core-parity x --pages README.md",
  ...overrides,
})

const manifest: Manifest = {
  clis: ["max", "tg"],
  options: { "--allow-send": { meaning: "offer the send tool" } },
  globalOptions: {},
  commands: { mcp: { in: "all", options: { "--allow-send": "all" } } },
}

const input = (max: Partial<CliSide> = {}, tg: Partial<CliSide> = {}): AuditInput => ({
  shared: { commit: "def5678", version: "0.9.0" },
  manifest,
  standard: "## Documents\n\n- max `bot.md` — tg has no bot side.\n\n## The parity manifest\n",
  sides: { max: side("max", max), tg: side("tg", tg) },
})

describe("the parity audit", () => {
  it("splits lists into what every one has and what only some have", () => {
    expect(split({ max: ["a", "b"], tg: ["b", "c"], wa: ["b", "c"] })).toEqual({
      all: ["b"],
      some: [
        ["a", ["max"]],
        ["c", ["tg", "wa"]],
      ],
    })
  })

  it("passes every --allow- option of mcp without treating it as configured exposure", () => {
    const flags = ["--allow-send", "--confirm-send", "--allow-delete"]
    expect(allowFlags({ cli: "max", global_options: [], commands: [mcp(flags)] })).toEqual([
      "--allow-send",
      "--allow-delete",
    ])
  })

  it("knows a page one tool has alone only when STANDARD's Documents rule names it", () => {
    const pages = pageSplit(input({ pages: { "docs/bot.md": "", "docs/protocol.md": "" } }, { pages: {} }))
    expect(pages.some).toEqual([
      ["bot.md", ["max"]],
      ["protocol.md", ["max"]],
    ])
    expect(pages.explained("bot.md")).toBe(true)
    expect(pages.explained("protocol.md")).toBe(false)
  })

  it("leaves the generated command list and the docs index out of the pages", () => {
    expect(pageSplit(input()).all).toEqual(["usage.md"])
  })

  it("sees the page check behind a pnpm script and its absence", () => {
    expect(ciRuns(side("tg"))).toEqual({ parity: true, pages: true })
    expect(ciRuns(side("max", { ci: "run: pnpm parity:check node x | cli-core-parity max" }))).toEqual({
      parity: true,
      pages: false,
    })
  })

  it("reports a CLI that lacks a both row, tools one has alone and a page with fewer headings", () => {
    const report = renderAudit(
      input(
        { tools: ["max_messages_send", "max_chats_check"] },
        { program: { cli: "tg", global_options: [], commands: [mcp([])] }, pages: { "docs/usage.md": "## a\n" } },
      ),
    )
    expect(report).toContain("🔴 **tg against this manifest** — 1 difference(s) `mcp --allow-send:")
    expect(report).toContain("| `chats_check` | ✅ | — |")
    expect(report).toContain("🔴 `usage.md` — max 4, tg 1 headings (7, 1 lines)")
    expect(report).toContain("✅ **max against this manifest**")
  })

  it("gives each of three CLIs its own line and column", () => {
    const report = renderAudit({
      ...input(),
      manifest: { ...manifest, clis: ["max", "tg", "wa"] },
      sides: { max: side("max"), tg: side("tg"), wa: side("wa", { tools: [] }) },
    })
    expect(report).toContain("✅ **wa against this manifest**")
    expect(report).toContain("| | max | tg | wa |")
    expect(report).toContain("| `messages_send` | ✅ | ✅ | — |")
  })
})
