import { captureStreams } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { expect, it } from "vitest"
import { LOCAL_READ, LOCAL_WRITE } from "../cli/effects.js"
import { run } from "../cli/program.js"
import { commandsCommand } from "../cli/shared-command-exports.js"
import { ownCatalogue } from "./own-catalogue.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "Own", version: "1.0.0" }
const own = () =>
  new Command("deals")
    .addCommand(annotate(new Command("list"), { effects: LOCAL_READ }).action(() => {}))
    .addCommand(annotate(new Command("close"), { effects: LOCAL_WRITE }).action(() => {}))

it("marks what cli-core mounted, and leaves it out of the CLI's own catalogue", async () => {
  const program = new Command("app").addCommand(commandsCommand(app)).addCommand(own())
  expect(ownCatalogue(program)).toEqual({ "deals list": "read", "deals close": "write" })

  const streams = captureStreams()
  const code = await run(
    ["commands", "--json"],
    { app, commands: () => [commandsCommand(app), own()] },
    {
      streams,
      tty: false,
      env: process.env,
    },
  )
  expect(code).toBe(0)
  const commands = JSON.parse(streams.stdout.join("")).commands as {
    name: string
    provided_by?: string
    commands: { name: string; provided_by?: string }[]
  }[]
  const at = (name: string) => commands.find((command) => command.name === name)
  expect(at("commands")?.provided_by).toBe("cli-core")
  expect(at("commands")?.commands.map((command) => command.provided_by)).toEqual(["cli-core"])
  expect(at("deals")).not.toHaveProperty("provided_by")
  expect(at("deals")?.commands.every((command) => command.provided_by === undefined)).toBe(true)
})
