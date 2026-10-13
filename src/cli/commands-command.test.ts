import { captureStreams } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it, vi } from "vitest"
import { commandsCommand } from "./commands-command.js"
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
                mutates: true,
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
      mutates: true,
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
    expect(packet.commands[0].commands).toMatchObject([{ path: ["bot", "messages", "send"], mutates: true }])
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
})
