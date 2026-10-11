import { readFileSync } from "node:fs"
import type { CommandInfo } from "@wirecat/cli-base/commands"
import { describe, expect, it } from "vitest"
import { type CommandsJson, type Manifest, manifestProblems, parityProblems } from "./manifest.js"

const shipped: Manifest = JSON.parse(readFileSync(new URL("../../parity.json", import.meta.url), "utf8"))

const command = (path: string, options: string[] = [], commands: CommandInfo[] = []): CommandInfo => ({
  path: path.split(" "),
  name: path.split(" ").at(-1) ?? path,
  description: "",
  usage: "",
  origin: "handwritten",
  arguments: [],
  options: options.map((flags) => ({ flags, description: "", takesValue: false, mandatory: false })),
  commands,
})

const program = (...commands: CommandInfo[]): CommandsJson => ({ cli: "tg", globalOptions: [], commands })

const manifest = (commands: Manifest["commands"], clis = ["max", "tg"]): Manifest => ({
  clis,
  options: { "--all": { meaning: "every row" }, "--max": { value: "<n>", meaning: "at most" } },
  globalOptions: {},
  commands,
})

describe("the shipped parity.json", () => {
  it("is well-formed", () => {
    expect(manifestProblems(shipped)).toEqual([])
  })
})

describe("manifestProblems", () => {
  it("wants a reason where a CLI lacks it, who closes a plan, and every option catalogued", () => {
    const problems = manifestProblems(
      manifest({
        chats: { in: ["max"] },
        store: { in: [], planned: { max: "", tg: "T6" }, options: { "--all": "all", "--max": "all", "--nope": "all" } },
      }),
    )

    expect(problems).toEqual([
      "chats: not in tg, without a reason",
      "store: planned for max without who closes it",
      "store --nope: not in the option catalogue",
    ])
  })

  it("refuses a row that a row only one CLI has, for a reason, already covers", () => {
    const problems = manifestProblems({
      ...manifest({ topics: { in: ["tg"], reason: "MAX has none" }, "topics list": { in: "all" } }),
      options: {},
    })

    expect(problems).toEqual(['topics list: under "topics", which is tg-only and covers it'])
  })

  it("allows explicit options under a provider-only resource", () => {
    const declared = {
      ...manifest({
        topics: { in: ["tg"], reason: "MAX has none" },
        "topics enable": { in: ["tg"], reason: "MAX has none", options: { "--all": "all" } },
      }),
      options: { "--all": { meaning: "synthetic option" } },
    }
    expect(manifestProblems(declared)).toEqual([])
  })

  it("knows only the CLIs it lists, and a plan only for a CLI that lacks the command", () => {
    const problems = manifestProblems({
      ...manifest(
        {
          chats: { in: ["max", "wa"], planned: { tg: "T6", li: "?" } },
          store: { in: ["max", "tg", "wa"] },
          topics: { in: ["tg"], planned: { tg: "P2", wa: "W1" }, reason: "MAX has none" },
        },
        ["max", "tg", "wa"],
      ),
      options: {},
    })

    expect(problems).toEqual([
      'chats: no such CLI "li" — the manifest\'s clis are max, tg, wa',
      'store: in every CLI — write "all"',
      "topics: planned for tg, which has it",
    ])
  })

  it("wants each CLI listed once, and a row no CLI has planned for every one of them", () => {
    const empty = { ...manifest({}), options: {} }

    expect(manifestProblems({ ...empty, clis: ["max", "max"] })).toEqual(["clis: a CLI named twice"])
    expect(manifestProblems({ ...empty, commands: { bot: { in: [], planned: { tg: "P8" } } } })).toEqual([
      "bot: not in max, without a reason",
    ])
  })
})

describe("parityProblems", () => {
  it("exempts provider-native generated operations while still checking the common API group", () => {
    const rows = manifest({ bot: { in: "all" }, "bot api": { in: "all", options: { "--all": "all" } } })
    const native: CommandInfo = {
      ...command("bot api provider-operation", ["--native-field <value>"]),
      origin: "generated",
      operationId: "providerOperation",
    }
    const tree = (child: CommandInfo, flags = ["--all"]) =>
      program(command("bot", [], [command("bot api", flags, [child])]))
    expect(parityProblems(rows, "tg", tree(native))).toEqual([])
    expect(parityProblems(rows, "tg", tree(native, []))).toEqual(["bot api --all: the manifest says all, tg lacks it"])
    expect(parityProblems(rows, "tg", tree(command("bot api handwritten")))).toEqual([
      "bot api handwritten: not in the manifest — add its row first",
    ])
    const noOperation: CommandInfo = { ...command("bot api unclassified"), origin: "generated" }
    expect(parityProblems(rows, "tg", tree(noOperation))).toEqual([
      "bot api unclassified: not in the manifest — add its row first",
    ])
    expect(parityProblems(rows, "tg", program({ ...native, path: ["messages", "provider-operation"] }))).toContain(
      "messages provider-operation: not in the manifest — add its row first",
    )
  })

  const rows = manifest({
    store: { in: "all" },
    "store fetch": { in: "all", options: { "--all": "all", "--max": { in: [], planned: { max: "P1", tg: "P1" } } } },
    "store jobs": { in: ["tg"], planned: { max: "T6" } },
    bot: { in: [], planned: { max: "P8", tg: "P8" }, subtree: true },
    topics: { in: ["tg"], reason: "MAX has none" },
  })

  it("passes a CLI that has what its column says, planned or not", () => {
    const tg = program(
      command("store", [], [command("store fetch", ["--all", "--max <n>"]), command("store jobs")]),
      command("topics", [], [command("topics list")]),
    )
    const max = program(
      command("store", [], [command("store fetch", ["--all"])]),
      command("bot", [], [command("bot messages send", ["--text <text>"])]),
    )

    expect(parityProblems(rows, "tg", tg)).toEqual([])
    expect(parityProblems(rows, "max", max)).toEqual([])
  })

  it("passes a planned CLI that has the command already, whatever options it has", () => {
    const max = program(
      command("store", [], [command("store fetch", ["--all"]), command("store jobs", ["--follow"])]),
      command("bot", ["--quiet"]),
    )

    expect(parityProblems(rows, "max", max)).toEqual([])
  })

  it("names what is missing from the manifest, from the CLI, and on the wrong side", () => {
    const max = program(
      command("store", [], [command("store fetch", ["--background"]), command("store info")]),
      command("topics"),
    )

    expect(parityProblems(rows, "max", max)).toEqual([
      "store fetch --all: the manifest says all, max lacks it",
      "store fetch --background: not in the manifest — add its row first",
      "store info: not in the manifest — add its row first",
      "topics: max has it, the manifest says tg-only",
    ])
  })

  it("checks each of three CLIs against its own column", () => {
    const three = manifest(
      {
        chats: { in: "all" },
        polls: { in: ["max", "tg"], reason: "WhatsApp polls cannot be read back" },
        topics: { in: ["tg"], reason: "only Telegram has topics", planned: { wa: "W2" } },
      },
      ["max", "tg", "wa"],
    )
    const wa = program(command("chats"), command("polls"))

    expect(parityProblems(three, "wa", wa)).toEqual(["polls: wa has it, the manifest says max+tg"])
    expect(parityProblems(three, "wa", program(command("chats"), command("topics")))).toEqual([])
    expect(parityProblems(three, "max", program(command("chats")))).toEqual([
      "polls: the manifest says max+tg, max lacks it",
    ])
  })
})
