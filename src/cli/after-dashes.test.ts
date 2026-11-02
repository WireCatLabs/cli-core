import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { liftOptionsAfterDashes } from "./after-dashes.js"

const root = new Command("chat").option("--json").option("--debug")
const sync = root
  .command("sync")
  .argument("<chat>")
  .option("--limit <n>")
  .option("--since [time]")
  .option("--no-record")
const send = annotate(root.command("send"), { literal_after_dashes: true }).argument("<chat>").argument("[text]")
const lift = (argv: string[], command: Command = sync) => liftOptionsAfterDashes(argv, () => command)

describe("liftOptionsAfterDashes", () => {
  it("moves the command's own and inherited options in front of --, a value with its option", () => {
    expect(lift(["sync", "--", "-100", "--json", "--limit", "5", "--no-record"])).toEqual([
      "sync",
      "--json",
      "--limit",
      "5",
      "--no-record",
      "--",
      "-100",
    ])
    expect(lift(["sync", "--", "-100", "--limit=5", "--json=id"])).toEqual([
      "sync",
      "--limit=5",
      "--json=id",
      "--",
      "-100",
    ])
  })

  it("keeps a word that is not exactly one of the command's options", () => {
    expect(lift(["sync", "--", "-100", "--jsn", "--json-ish", "-j", "--"])).toEqual([
      "sync",
      "--",
      "-100",
      "--jsn",
      "--json-ish",
      "-j",
      "--",
    ])
  })

  it("never takes the next word as an optional value", () => {
    expect(lift(["sync", "--", "--since", "-100"])).toEqual(["sync", "--since", "--", "-100"])
  })

  it("leaves argv as it was without --, with nothing to move, or in a command marked literal_after_dashes", () => {
    expect(lift(["sync", "-100", "--json"])).toEqual(["sync", "-100", "--json"])
    expect(lift(["sync", "--", "-100"])).toEqual(["sync", "--", "-100"])
    expect(lift(["send", "7", "--", "--json"], send)).toEqual(["send", "7", "--", "--json"])
    expect(liftOptionsAfterDashes(["nothing", "--", "--json"], () => undefined)).toEqual(["nothing", "--", "--json"])
  })
})
