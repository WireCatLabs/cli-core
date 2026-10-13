import type { CommandInfo } from "@wirecat/cli-base/commands"
import { describe, expect, it } from "vitest"
import type { CommandsJson, Manifest } from "./manifest.js"
import { pageProblems } from "./pages.js"

const command = (path: string, options: string[] = [], commands: CommandInfo[] = []): CommandInfo => ({
  path: path.split(" "),
  name: path.split(" ").at(-1) ?? path,
  description: "",
  usage: "",
  origin: "handwritten",
  arguments: [],
  options: options.map((flags) => ({ flags, description: "", takes_value: false, mandatory: false })),
  commands,
})

const program: CommandsJson = {
  cli: "tg",
  global_options: [{ flags: "--json", description: "", takes_value: false, mandatory: false }],
  commands: [
    command("store", [], [command("store fetch", ["--last <n>"])]),
    command("server", [], [command("server status")]),
    command("messages", [], [command("messages send", ["--md, --markdown"])]),
  ],
}

const manifest: Manifest = {
  clis: ["max", "tg"],
  options: {},
  globalOptions: {},
  commands: {
    "messages send": {
      in: "all",
      options: { "--voice": { in: [], planned: { max: "P1", tg: "P1" } }, "--sticker": { in: ["max"], reason: "MAX" } },
    },
  },
}

const problems = (page: string) => pageProblems(page, "tg", manifest, program)

describe("options a user page names", () => {
  it("accepts implicit help on command groups, nested commands and profiles, while rejecting typos", () => {
    expect(
      problems("tg store --help\ntg store fetch --help\ntg work server status --help\ntg server status --helps"),
    ).toEqual(["tg server status --helps"])
  })
  it("refuses an option the command no longer has", () => {
    expect(problems("```sh\ntg store fetch Chat --max 5000\n```")).toEqual(["tg store fetch --max"])
  })

  it("allows the command's own options, both spellings, and the global ones", () => {
    expect(problems("`tg messages send me hi --markdown --md --json`")).toEqual([])
  })

  it("allows what the manifest plans for this CLI, not what only the other one has", () => {
    expect(problems("tg messages send me --voice a.ogg --sticker x")).toEqual(["tg messages send --sticker"])
  })

  it("reads past a profile word", () => {
    expect(problems("tg work store fetch Chat --max 1")).toEqual(["tg store fetch --max"])
  })

  it("stops at the end of a line", () => {
    expect(problems("tg server status\nsystemctl --user enable it")).toEqual([])
  })

  it("reads only its own CLI's lines", () => {
    expect(problems("max store fetch Chat --max 5")).toEqual([])
  })
})
