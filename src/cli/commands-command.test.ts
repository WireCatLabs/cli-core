import { captureStreams } from "@wirecat/cli-base"
import { annotate, describeProgram } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it, vi } from "vitest"
import { commandsCommand } from "./commands-command.js"
import { commandsText } from "./help/commands-text.js"
import { inSection } from "./help/sections.js"
import { run } from "./program.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "Discovery", version: "1.2.3" }

const call = async (path: string[], pretty = false) => {
  const action = vi.fn(() => {
    throw new Error("discovery must not execute the inspected command")
  })
  const streams = captureStreams()
  const code = await run(
    ["commands", ...path, ...(pretty ? [] : ["--json"])],
    {
      app,
      commands: () => [
        commandsCommand(app),
        new Command("bot")
          .alias("b")
          .option("--account <name>", "which bot")
          .addCommand(
            new Command("messages").option("--scope <chat>", "inherited scope").addCommand(
              annotate(new Command("send").alias("post").argument("<text>").option("--silent").action(action), {
                effects: { remote: "write", local: "write" },
              }),
            ),
          ),
        new Command("hidden").action(action),
        new Command("messages").addCommand(new Command("search").action(action)),
        new Command("chats").addCommand(new Command("list").action(action)),
        new Command("contacts").addCommand(new Command("list").action(action)),
      ],
      configure: (root) => {
        root.addCommand(new Command("private").action(action), { hidden: true })
      },
    },
    { streams, tty: pretty, env: process.env },
  )
  expect(action).not.toHaveBeenCalled()
  return { code, stdout: streams.stdout.join("\n"), stderr: streams.stderr.join("\n") }
}

describe("scoped command discovery", () => {
  it("keeps the full-tree envelope without scope fields when no path is given", async () => {
    const result = await call([])
    expect(result.code).toBe(0)
    const packet = JSON.parse(result.stdout)
    expect(Object.keys(packet).sort()).toEqual(
      ["cli", "version", "contract", "description", "global_options", "commands", "exit_codes"].sort(),
    )
    expect(packet.commands.map((command: { name: string }) => command.name)).toEqual([
      "commands",
      "bot",
      "hidden",
      "messages",
      "chats",
      "contacts",
    ])
    expect(packet.exit_codes.validation_error).toBe(2)
  })

  it("canonicalizes aliases and includes all inherited options while omitting unrelated commands", async () => {
    const result = await call(["b", "messages", "post"])
    expect(result.code).toBe(0)
    const packet = JSON.parse(result.stdout)
    expect(packet.scope).toEqual(["bot", "messages", "send"])
    expect(packet.commands).toHaveLength(1)
    expect(packet.commands[0]).toMatchObject({
      path: ["bot", "messages", "send"],
      usage: "app bot messages send <text> [options]",
      effects: { remote: "write", local: "write" },
      arguments: [{ name: "text", required: true }],
      options: [{ flags: "--silent", takes_value: false }],
    })
    expect(packet.inherited_options).toMatchObject([
      { path: ["bot"], options: [{ flags: "--account <name>" }] },
      { path: ["bot", "messages"], options: [{ flags: "--scope <chat>" }] },
    ])
    const full = JSON.parse((await call([])).stdout)
    expect(packet.global_options).toEqual(full.global_options)
    expect(packet.exit_codes).toEqual(full.exit_codes)
    expect(result.stdout.length).toBeLessThan(JSON.stringify(full).length)
  })

  it("includes a group's descendants and their metadata", async () => {
    const packet = JSON.parse((await call(["bot", "messages"])).stdout)
    expect(packet.commands[0].commands).toMatchObject([
      { path: ["bot", "messages", "send"], effects: { remote: "write" } },
    ])
    expect(packet.inherited_options).toMatchObject([{ path: ["bot"] }])
  })

  it.each([["missing"], ["private"], ["bot", "missing"], ["bot", "messages", "send", "missing"]])(
    "refuses invalid or hidden paths with actionable validation errors: %j",
    async (...path) => {
      const result = await call(path)
      expect(result.code).toBe(2)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("unknown command path")
      expect(result.stderr).toContain("app commands")
      expect(JSON.parse(result.stderr).error.code).toBe("validation_error")
    },
  )

  it("scopes the human-readable table too", async () => {
    const result = await call(["bot", "messages"], true)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("app bot messages send")
    expect(result.stdout).not.toContain("app hidden")
  })

  it("explains that multiple groups need separate discovery calls", async () => {
    const result = await call(["messages", "chats", "contacts"])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe("")
    const { error } = JSON.parse(result.stderr)
    expect(error.code).toBe("validation_error")
    expect(error.message).toContain("one command path per call, not a list of groups")
    expect(error.message).toContain("app commands messages --json")
    expect(error.message).toContain("app commands chats --json")
    expect(error.details.at).toBe("chats")
    expect(error.details.available).toEqual(["search"])
  })

  it("names the CLI's own groups in its example, not a messenger's", async () => {
    const calendar = { ...app, command: "gcal", messenger: false }
    const streams = captureStreams()
    const leaf = (name: string) => new Command(name).action(() => undefined)
    const code = await run(
      ["commands", "chats", "--json"],
      {
        app: calendar,
        commands: () => [
          commandsCommand(calendar),
          new Command("calendars").addCommand(leaf("list")),
          new Command("events").addCommand(leaf("list")),
          leaf("sync"),
        ],
      },
      { streams, tty: false, env: process.env },
    )
    expect(code).toBe(2)
    const { message } = JSON.parse(streams.stderr.join("\n")).error
    expect(message).toContain("`gcal commands calendars --json` and `gcal commands events --json` are separate calls")
    expect(message).not.toMatch(/messages|chats --json/)
  })
})

describe("commands as text", () => {
  const leaf = (name: string, description: string, remote: "read" | "write" = "read") =>
    annotate(new Command(name), { effects: { remote, local: "read" } })
      .description(description)
      .action(() => {})
  const tool = {
    app,
    commands: () => [
      commandsCommand(app),
      new Command("messages")
        .addCommand(leaf("list", "a chat's messages, oldest to newest").argument("<chat>"))
        .addCommand(leaf("send", "send a message", "write").argument("<chat>").argument("[text]")),
      new Command("tags").addCommand(leaf("list", "what is tagged")),
      new Command("schedule").addCommand(leaf("add", "run a command on a timer", "write").argument("<when>")),
      inSection(new Command("session"), "setup").addCommand(leaf("start", "log in", "write")),
      new Command("extras").addCommand(leaf("show", "something no section claims")),
    ],
  }
  const text = async (argv: string[]) => {
    const streams = captureStreams()
    const code = await run(argv, tool, { streams, tty: false, env: {} })
    return { code, stdout: streams.stdout.join("\n"), stderr: streams.stderr.join("\n") }
  }

  it("prints every command by section, one line each, when piped without --json", async () => {
    const { code, stdout } = await text(["commands"])

    expect(code).toBe(0)
    expect(stdout).toMatchInlineSnapshot(`
      "app commands, by section. One command's arguments and options: app <command> --help.
      As JSON: app commands --json. (writes) marks a command that changes something.

      Read
        app messages list <chat>                              a chat's messages, oldest to newest
        app messages send <chat> [text]                       send a message (writes)

      Organise
        app tags list                                         what is tagged

      Automate
        app schedule add <when>                               run a command on a timer (writes)

      Set up
        app commands [path]                                   every command by section; --json prints its contract, one path per call
        app commands info [path]                              one command contract, or all schemas, error reasons and explicit overrides
        app session start                                     log in (writes)

      Other
        app extras show                                       something no section claims"
    `)
  })

  it("narrows to one group", async () => {
    const { stdout } = await text(["commands", "messages"])

    expect(stdout).toContain("app messages commands, by section")
    expect(stdout).toContain("app messages send <chat> [text]")
    expect(stdout).not.toContain("tags")
  })

  it("lists a program a tool builds itself the same way, cli-core's groups in their sections", () => {
    const program = new Command("memo")
      .addCommand(new Command("people").addCommand(leaf("show", "one person")))
      .addCommand(new Command("mcp").addCommand(leaf("serve", "serve memo to an agent")))

    const listed = commandsText(program, describeProgram(program))

    expect(listed).toContain("Automate\n  memo mcp serve")
    expect(listed).toContain("Other\n  memo people show")
  })

  it("keeps discovery as one JSON document and refuses JSONL before printing", async () => {
    expect(JSON.parse((await text(["commands", "--json"])).stdout).contract).toBe(3)
    for (const path of [["commands"], ["commands", "chats"], ["commands", "info", "chats", "list"]]) {
      const result = await text([...path, "--jsonl"])
      expect(result.code).toBe(2)
      expect(result.stdout).toBe("")
      expect(JSON.parse(result.stderr).error).toMatchObject({ code: "validation_error", reason: "output.one-object" })
    }
  })
})
