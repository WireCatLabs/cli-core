import { readFileSync } from "node:fs"
import type { CommandInfo } from "@wirecat/cli-base/commands"
import { describe, expect, it } from "vitest"
import { type CommandsJson, type Manifest, manifestProblems, parityProblems } from "./manifest.js"
import { formatManifest, seedCli, seedPrograms } from "./seed.js"

const shipped: Manifest = JSON.parse(readFileSync(new URL("../../parity.json", import.meta.url), "utf8"))

const command = (path: string, options: string[] = [], commands: CommandInfo[] = []): CommandInfo => ({
  path: path.split(" "),
  name: path.split(" ").at(-1) ?? path,
  description: "",
  usage: "",
  origin: "handwritten",
  arguments: [],
  options: options.map((flags) => ({ flags, description: flags, takes_value: false, mandatory: false })),
  commands,
})

const program = (cli: string, ...commands: CommandInfo[]): CommandsJson => ({ cli, global_options: [], commands })

const manifest: Manifest = {
  clis: ["max", "tg"],
  options: { "--all": { meaning: "every row" } },
  globalOptions: {},
  commands: {
    store: { in: "all" },
    "store fetch": { in: "all", options: { "--all": "all" } },
    topics: { in: ["tg"], reason: "MAX has none" },
  },
}

describe("a new CLI joining parity", () => {
  it("is planned for every row and option, so its first check passes with nothing built", () => {
    const seeded = seedCli(manifest, "wa")

    expect(seeded.clis).toEqual(["max", "tg", "wa"])
    expect(seeded.commands["store fetch"]).toEqual({
      in: ["max", "tg"],
      planned: { wa: "?" },
      options: { "--all": { in: ["max", "tg"], planned: { wa: "?" } } },
    })
    expect(seeded.commands.topics).toEqual({ in: ["tg"], reason: "MAX has none", planned: { wa: "?" } })
    expect(manifestProblems(seeded)).toEqual([])
    expect(parityProblems(seeded, "wa", program("wa"))).toEqual([])
  })

  it("leaves the shipped manifest well-formed and max and tg checked as before", () => {
    const seeded = seedCli(shipped, "wa")
    const max = program("max", command("store", [], [command("store fetch", ["--all"])]))

    expect(manifestProblems(seeded)).toEqual([])
    const where = (problems: string[]) => problems.map((problem) => problem.split(":")[0])
    expect(where(parityProblems(seeded, "max", max))).toEqual(where(parityProblems(shipped, "max", max)))
    expect(where(parityProblems(seeded, "tg", program("tg")))).toEqual(
      where(parityProblems(shipped, "tg", program("tg"))),
    )
  })

  it("refuses a CLI already there", () => {
    expect(() => seedCli(manifest, "tg")).toThrow(/already/)
  })
})

describe("seeding from the CLIs' commands", () => {
  it("adds a row all have as all, and one some lack as planned for the rest by ?", () => {
    const seeded = seedPrograms(manifest, [
      program("max", command("store", [], [command("store fetch", ["--all", "--since <t>"]), command("store info")])),
      program("tg", command("store", [], [command("store fetch", ["--all"]), command("store info")])),
    ])

    expect(seeded.commands["store info"]).toEqual({ in: "all" })
    expect(seeded.commands["store fetch"]?.options).toEqual({
      "--all": "all",
      "--since": { in: ["max"], planned: { tg: "?" } },
    })
    expect(seeded.options["--since"]).toEqual({ value: "<t>", meaning: "--since <t>" })
  })

  it("gives a row one CLI has alone, for a reason, no options: it covers what is below it", () => {
    const seeded = seedPrograms(manifest, [program("max"), program("tg", command("topics", ["--pinned"]))])

    expect(seeded.commands.topics).toEqual({ in: ["tg"], reason: "MAX has none" })
  })

  it("wants a commands --json for every CLI of the manifest", () => {
    expect(() => seedPrograms(manifest, [program("max")])).toThrow(/no commands --json for tg/)
  })

  it("writes each list of CLIs on one line, as Biome formats parity.json", () => {
    expect(formatManifest({ clis: ["max", "tg"], row: { in: ["max"] } })).toBe(
      '{\n  "clis": ["max", "tg"],\n  "row": {\n    "in": ["max"]\n  }\n}\n',
    )
  })
})
