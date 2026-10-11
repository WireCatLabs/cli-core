import type { CommandInfo } from "@wirecat/cli-base/commands"
import { describe, expect, it } from "vitest"
import type { CommandsJson, Manifest } from "./manifest.js"
import { wordingProblems } from "./wording.js"

const program = (cli: string, pause: string): CommandsJson => {
  const fetch: CommandInfo = {
    path: ["store", "fetch"],
    name: "fetch",
    description: "",
    usage: "",
    origin: "handwritten",
    arguments: [],
    options: [{ flags: "--pause <duration>", description: pause, takesValue: true, mandatory: false }],
    commands: [],
  }
  return { cli, globalOptions: [], commands: [fetch] }
}

const manifest = (note?: string, clis = ["max", "tg"]): Manifest => ({
  clis,
  options: { "--pause": { value: "<duration>", meaning: "wait", ...(note ? { note } : {}) } },
  globalOptions: {},
  commands: { store: { in: "all" }, "store fetch": { in: "all", options: { "--pause": "all" } } },
})

describe("one sentence per shared option", () => {
  it("names a shared option the two tools describe differently", () => {
    expect(wordingProblems(manifest(), [program("max", "wait"), program("tg", "pause")])).toEqual([
      'store fetch --pause: max says "wait", tg says "pause"',
    ])
  })

  it("passes the same sentence, and leaves a clash the catalogue already notes", () => {
    expect(wordingProblems(manifest(), [program("max", "wait"), program("tg", "wait")])).toEqual([])
    expect(
      wordingProblems(manifest("max's own copy until T6"), [program("max", "wait"), program("tg", "pause")]),
    ).toEqual([])
  })

  it("compares every CLI that has the option, known by its name, not by its place", () => {
    const three = manifest(undefined, ["max", "tg", "wa"])
    const programs = [program("wa", "pause"), program("tg", "wait"), program("max", "wait")]

    expect(wordingProblems(three, programs)).toEqual([
      'store fetch --pause: max says "wait", tg says "wait", wa says "pause"',
    ])
  })

  it("leaves out a CLI the option is not in", () => {
    const three: Manifest = {
      ...manifest(undefined, ["max", "tg", "wa"]),
      commands: {
        store: { in: "all" },
        "store fetch": { in: "all", options: { "--pause": { in: ["max", "tg"], reason: "WhatsApp pages nothing" } } },
      },
    }

    expect(wordingProblems(three, [program("max", "wait"), program("tg", "wait"), program("wa", "pause")])).toEqual([])
  })
  it("does not compare options of a planned command unavailable in one messenger", () => {
    const planned = manifest()
    planned.commands["store fetch"] = {
      in: [],
      planned: { tg: "adopt" },
      reason: "MAX lacks this command",
      options: { "--pause": "all" },
    }
    expect(wordingProblems(planned, [{ ...program("max", "wait"), commands: [] }, program("tg", "pause")])).toEqual([])
  })

  it("does not compare an absent command planned for both consumers", () => {
    const planned = manifest()
    planned.commands["store fetch"] = { in: [], planned: { max: "adopt", tg: "adopt" }, options: { "--pause": "all" } }
    expect(wordingProblems(planned, [{ ...program("max", "wait"), commands: [] }, program("tg", "pause")])).toEqual([])
  })

  it("still reports a missing option when both messengers must have the command", () => {
    expect(wordingProblems(manifest(), [{ ...program("max", "wait"), commands: [] }, program("tg", "pause")])).toEqual([
      'store fetch --pause: max says "undefined", tg says "pause"',
    ])
  })
})
