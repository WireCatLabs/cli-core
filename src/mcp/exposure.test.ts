import { describeProgram, flatten, metaOf } from "@wirecat/cli-base/commands"
import { describe, expect, it } from "vitest"
import { chatsCommand } from "../cli/messenger/chats-command.js"
import { createProgram } from "../cli/program.js"
import { upgradeCommand } from "../cli/upgrade-command.js"
import { app, messenger, sharedProgram } from "../testing/shared-program.js"
import { toolsFromCommands } from "./agent.js"

const commands = () => describeProgram(createProgram(sharedProgram))
/** With `chats delete` and `chats clear`, which tg and max mount and the synthetic messenger does not. */
const withChatDeletion = () =>
  describeProgram(
    createProgram({
      app,
      commands: () =>
        sharedProgram
          .commands()
          .map((one) => (one.name() === "chats" ? chatsCommand({ ...messenger, chatDeletion: true }) : one)),
    }),
  )

describe("what the shared commands keep off MCP servers (NEED-1411, owner 2026-10-23)", () => {
  it.each([
    "mcp",
    "flood",
    "complete",
    "account sessions end",
    "chats delete",
    "chats clear",
    "bot auth",
    "bot recipients add",
    "bot mcp",
  ])("%s", (path) => {
    const found = flatten(withChatDeletion()).find((one) => one.path.join(" ") === path)

    expect(found, path).toBeDefined()
    expect(found?.mcp).toBe(false)
    for (const below of flatten(found?.commands ?? [])) expect(below.mcp, below.path.join(" ")).toBe(false)
  })

  it.each([
    "attachments jobs status",
    "attachments move",
    "commands schema",
    "config show",
    "doctor report",
    "guide",
    "models audio list",
    "replies status",
    "runs list",
    "schedule list",
    "server status",
    "server logs",
    "skill show",
    "store export",
    "store info",
    "store jobs cancel",
  ])("**offers %s**: a read, or a write its own permission key limits", (path) => {
    expect(toolsFromCommands(commands(), { exclude: [["bot"]] }).map((tool) => tool.command)).toContain(path)
  })

  it.each([
    "attachments jobs install",
    "config set",
    "doctor report create",
    "models audio download",
    "replies add",
    "schedule command",
    "schedule run",
    "server start",
    "skill install",
    "store backup",
    "store clear",
    "store reset",
    "store restore",
  ])("**keeps off %s**: it changes what a later run may do, or no permission key limits it", (path) => {
    expect(toolsFromCommands(commands(), { exclude: [["bot"]] }).map((tool) => tool.command)).not.toContain(path)
  })

  it("project candidates require a separately granted MCP tool", () => {
    const document = commands()
    const scan = flatten(document).find((one) => one.path.join(" ") === "meetings projects scan")
    expect(scan?.mcp).toBe(false)
    expect(toolsFromCommands(document).some((tool) => tool.command === "meetings projects scan")).toBe(false)
  })

  it("upgrade", () => {
    expect(metaOf(upgradeCommand(app, "chat-cli", () => ({}) as never)).mcp).toBe(false)
  })

  it("**an agent never deletes for everyone**: `messages delete` is offered without --for-everyone", () => {
    const remove = toolsFromCommands(commands(), { exclude: [["bot"]] }).find(
      (tool) => tool.command === "messages delete",
    )

    expect(Object.keys(remove?.input.entries ?? {}).sort()).toEqual(["chat", "message"])
  })

  it("**the personal catalogue is pinned**, so moving the personal server onto it changes nothing unseen", async () => {
    const listed = toolsFromCommands(commands(), { exclude: [["bot"]] })
      .map((tool) => `${tool.writes ? "write" : "read "} ${tool.command}`)
      .sort()

    await expect(`${listed.join("\n")}\n`).toMatchFileSnapshot("__snapshots__/personal-catalogue.snap")
  })
})
