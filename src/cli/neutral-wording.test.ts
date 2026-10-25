import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import { captureStreams } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { registerCommands } from "../mcp/index.js"
import { answered } from "../mcp/tool.js"
import { sharedProgram } from "../testing/shared-program.js"
import { storeChangeRefusal } from "./effects.js"
import { itemOf } from "./envelope.js"
import { profileFree } from "./profile.js"
import { createProgram, type ProgramDefinition, run } from "./program.js"
import { settingsFor } from "./settings.js"
import { commandsCommand, configCommand } from "./shared-command-exports.js"

const notesApp = {
  command: "notes",
  appName: "notes-cli",
  envPrefix: "NOTES",
  description: "notes",
  version: "1.0.0",
  messenger: false,
}
const notesConfig = settingsFor(notesApp)
const notes: ProgramDefinition = {
  app: notesApp,
  commands: () => [commandsCommand(notesApp), configCommand(notesApp, notesConfig)],
}

const at = (program: Command, ...path: string[]): Command =>
  path.reduce((command, name) => command.commands.find((one) => one.name() === name) as Command, program)
const option = (program: Command, long: string) => program.options.find((one) => one.long === long)?.description

const shownSettings = async (definition: ProgramDefinition, prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), "neutral-"))
  const streams = captureStreams()
  await run(["work", "config", "show", "--json"], definition, {
    streams,
    tty: false,
    env: { [`${prefix}_CONFIG_DIR`]: join(root, "config"), [`${prefix}_STATE_DIR`]: join(root, "state") },
  })
  return JSON.parse(streams.stdout[0] ?? "{}").item.settings.map((one: { setting: string }) => one.setting)
}

const mcpTexts = async (
  commands: string[],
  messenger?: boolean,
  input: Record<string, v.ObjectSchema<v.ObjectEntries, undefined>> = {},
) => {
  const server = new McpServer({ name: "x", version: "0" })
  registerCommands(
    server,
    "x",
    Object.fromEntries(
      commands.map((command) => [
        command,
        {
          title: command,
          description: command,
          writes: command.endsWith("delete"),
          input: input[command] ?? v.object({}),
          run: async () => answered(itemOf({})),
        },
      ]),
    ),
    undefined,
    undefined,
    messenger,
  )
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "fixture", version: "0" })
  await client.connect(clientSide)
  try {
    return JSON.stringify((await client.listTools()).tools)
  } finally {
    await client.close()
  }
}

describe("shared wording", () => {
  it("**speaks of chats and messages for a messenger**, as tg, max and wa print it", async () => {
    const program = createProgram(sharedProgram)

    expect(program.description()).toContain("`chat personal chats list`")
    expect(option(program, "--brief")).toBe("found messages as reference, title, time, sender and excerpt only")
    expect(option(program, "--record")).toBe("keep this run — ids and timings, never message content")
    expect(metaOf(at(program, "commands", "info")).examples).toEqual(["chat commands info messages list"])
    expect(at(program, "commands").registeredArguments[0]?.description).toContain("for example: search messages")
    expect(storeChangeRefusal(sharedProgram.app)).toBe("change the message store")
    expect(metaOf(at(program, "meetings", "scheduled")).examples).toEqual(["chat meetings scheduled --dry-run --json"])
    expect(at(program, "config", "set").registeredArguments[0]?.description).toContain("sender_colors")
    expect(await shownSettings(sharedProgram, "CHAT")).toContain("sender_colors")
    const tools = await mcpTexts(["messages list", "messages delete"])
    expect(tools).toContain('\\"unread\\", \\"send message\\", \\"chat members\\"')
    expect(tools).toContain('returned: \\"messages list\\"')
    expect(tools).toContain("sends, edits, deletes, joins")
  })

  it("**names the CLI's own commands and no chats** for a CLI that is not a messenger", async () => {
    const program = createProgram(notes)

    expect(program.description()).toContain("`notes personal config show`")
    expect(option(program, "--brief")).toBe("found items as reference, title, time, author and excerpt only")
    expect(option(program, "--full")).toBe("found items with their whole text and every provider field")
    expect(option(program, "--trace")).toBe("the connection's own log lines on stderr — never content")
    expect(metaOf(at(program, "commands", "info")).examples).toEqual(["notes commands info commands"])
    expect(at(program, "commands").registeredArguments[0]?.description).toContain("for example: commands info")
    expect(storeChangeRefusal(notesApp)).toBe("change the local store")
    expect(at(program, "config", "set").registeredArguments[0]?.description).not.toContain("sender_colors")
    expect(await shownSettings(notes, "NOTES")).not.toContain("sender_colors")
    const tools = await mcpTexts(["notes list", "notes delete"])
    expect(tools).toContain('\\"list\\", \\"show\\", \\"change a setting\\"')
    expect(tools).not.toMatch(/send message|chat members|messages list/)
    expect(tools).toContain('returned: \\"notes list\\"')
    expect(tools).toContain("creates, edits, deletes —")
  })

  it("**shows the profile with a command that takes one**, never a `profileFree` one", () => {
    const description = (commands: () => Command[]) => createProgram({ app: notesApp, commands }).description()

    expect(description(() => [profileFree(new Command("doctor")), new Command("mcp")])).toContain(
      "`notes personal mcp`",
    )
    expect(
      description(() => [
        new Command("sync").addCommand(profileFree(new Command("check"))).addCommand(new Command("run")),
      ]),
    ).toContain("`notes personal sync run`")
    const freeOnly = description(() => [profileFree(new Command("doctor"))])
    expect(freeOnly).toBe("notes")
  })

  it("**follows `AppIdentity.messenger`** over a catalogue that has `messages` commands, as memo's does", async () => {
    const tools = await mcpTexts(["messages show", "notes show", "notes list", "notes delete"], false, {
      "messages show": v.object({ id: v.string() }),
    })
    expect(tools).not.toMatch(/send message|chat members|unread|sends, edits, deletes, joins/)
    expect(tools).toContain('returned: \\"notes list\\"')
    expect(tools).toContain("names, titles, what people wrote")
    expect(tools).not.toContain("names, titles, messages")
  })

  it("examples a reading command that runs with no arguments, a listing first", async () => {
    const tools = await mcpTexts(["meetings show", "events list", "events delete"], false, {
      "meetings show": v.object({ id: v.string() }),
    })
    expect(tools).toContain('returned: \\"events list\\"')
  })
})
