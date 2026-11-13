import { captureStreams } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { expect, it } from "vitest"
import { LOCAL_READ, LOCAL_WRITE } from "../cli/effects.js"
import { run } from "../cli/program.js"
import { commandsCommand, generatedApiCommand } from "../cli/shared-command-exports.js"
import { addMeetingCommands } from "../meetings/cli/index.js"
import { memoryMeetingStore } from "../meetings/testing/index.js"
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
    origin?: string
    commands: { name: string; origin?: string }[]
  }[]
  const at = (name: string) => commands.find((command) => command.name === name)
  expect(at("commands")?.origin).toBe("cli-core")
  expect(at("commands")?.commands.map((command) => command.origin)).toEqual(["cli-core"])
  expect(at("deals")?.origin).toBe("handwritten")
  expect(at("deals")?.commands.every((command) => command.origin === "handwritten")).toBe(true)
})

it("marks the meeting commands cli-core mounts, as every other shared command (IDEA-288)", async () => {
  const meetings = () => {
    const program = new Command("app")
    addMeetingCommands(program, {
      store: memoryMeetingStore(),
      accountId: 1,
      write: () => {},
      inRun: (_command, body) => body(),
    })
    return program.commands
  }
  const program = new Command("app").addCommand(commandsCommand(app))
  for (const command of meetings()) program.addCommand(command)
  expect(Object.keys(ownCatalogue(program)).filter((path) => path.startsWith("meetings"))).toEqual([])

  const streams = captureStreams()
  const code = await run(
    ["commands", "--json"],
    { app, commands: () => [commandsCommand(app), ...meetings()] },
    { streams, tty: false, env: process.env },
  )
  expect(code).toBe(0)
  const commands = JSON.parse(streams.stdout.join("")).commands as {
    name: string
    origin?: string
    commands: { name: string; origin?: string }[]
  }[]
  const group = commands.find((command) => command.name === "meetings")
  expect(group?.origin).toBe("cli-core")
  expect(group?.commands.every((command) => command.origin === "cli-core")).toBe(true)
})

it("keeps a generated Bot API command in the CLI's own catalogue, as `commands --json` marks it", () => {
  const api = generatedApiCommand({
    operations: [
      {
        id: "getUpdates",
        command: "get-updates",
        binding: { kind: "http", method: "GET", path: "/updates" },
        effect: "read",
        tags: [],
        parameters: [],
      },
    ],
    checkParameter: () => {},
    checkBody: () => {},
    execute: async () => {},
  })
  const program = new Command("app").addCommand(commandsCommand(app)).addCommand(new Command("bot").addCommand(api))

  expect(ownCatalogue(program)).toEqual({ "bot api get-updates": "read" })
})
