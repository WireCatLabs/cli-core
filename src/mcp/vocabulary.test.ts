import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { run } from "../cli/program.js"
import { keyForCommand } from "../sends/permissions.js"
import { messenger, sharedProgram } from "../testing/shared-program.js"
import { commandOf, toolKey } from "./tool.js"
import { personalMcpTools } from "./tools.js"

const tools = personalMcpTools(messenger)

interface Listed {
  path: readonly string[]
  effects?: object
  commands: readonly Listed[]
}
/** A group that only holds subcommands declares no effects: `chats members` is not a command, `tasks duplicates` is. */
const runnable = (commands: readonly Listed[]): string[] =>
  commands.flatMap((one) => [
    ...(one.commands.length === 0 || one.effects ? [one.path.join(" ")] : []),
    ...runnable(one.commands),
  ])

const cliCommands = async (): Promise<Set<string>> => {
  const streams = captureStreams()
  await run(["commands", "--json"], sharedProgram, { streams, tty: false, env: {} })
  return new Set(runnable((JSON.parse(streams.stdout.join("")) as { commands: Listed[] }).commands))
}

describe("one vocabulary for the CLI and its agent catalogue", () => {
  it("lists every tool under a command the CLI has", async () => {
    const commands = await cliCommands()
    const strays = Object.entries(tools)
      .filter(([, definition]) => !definition.agentOnly)
      .map(([name, definition]) => commandOf(name, definition))
      .filter((command) => !commands.has(command))

    expect(strays).toEqual([])
    expect(
      Object.entries(tools)
        .filter(([, definition]) => definition.agentOnly)
        .map(([name]) => name)
        .sort(),
    ).toEqual(["conversations_refresh", "messages_photo"])
  })

  it("reads a tool's level from its command's permission key", () => {
    const drifted = Object.entries(tools)
      .filter(([, definition]) => definition.key === undefined)
      .filter(
        ([name, definition]) => toolKey(name, definition) !== keyForCommand(commandOf(name, definition).split(" ")),
      )

    expect(drifted).toEqual([])
    expect(toolKey("chats_send_as", tools.chats_send_as as never)).toBe("chats.send-as")
    expect(toolKey("chats_mark_read", tools.chats_mark_read as never)).toBe("chats.mark-read")
    expect(toolKey("chats_members", tools.chats_members as never)).toBe("chats.members.list")
  })

  it("names other commands by path in what the agent reads, never by a retired tool name", () => {
    const names = Object.keys(tools).filter((name) => name.includes("_"))
    const mentions = Object.entries(tools).flatMap(([name, definition]) => {
      const text = [definition.title, definition.description, JSON.stringify(definition.input)].join(" ")
      return names.filter((other) => new RegExp(`\\b${other}\\b`).test(text)).map((other) => `${name}: ${other}`)
    })

    expect(mentions).toEqual([])
  })
})
