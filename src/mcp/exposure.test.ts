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

describe("what the shared commands keep off MCP servers (NEED-1411)", () => {
  it.each([
    "store",
    "server",
    "schedule",
    "config",
    "mcp",
    "models",
    "skill",
    "flood",
    "runs",
    "replies",
    "doctor report",
    "complete",
    "commands schema",
    "account sessions end",
    "chats delete",
    "chats clear",
    "bot auth",
    "bot list",
    "bot recipients add",
    "bot webhooks",
    "bot commands set",
    "bot chats leave",
    "bot chats admins add",
    "bot mcp",
  ])("%s", (path) => {
    const found = flatten(withChatDeletion()).find((one) => one.path.join(" ") === path)

    expect(found, path).toBeDefined()
    expect(found?.mcp).toBe(false)
    for (const below of flatten(found?.commands ?? [])) expect(below.mcp, below.path.join(" ")).toBe(false)
  })

  it("upgrade", () => {
    expect(metaOf(upgradeCommand(app, "chat-cli", () => ({}) as never)).mcp).toBe(false)
  })

  it("**an agent never deletes for everyone**: `messages delete` is offered without --for-everyone", () => {
    const remove = toolsFromCommands(commands(), { exclude: [["bot"]] }).find(
      (tool) => tool.command === "messages delete",
    )

    expect(Object.keys(remove?.input.entries ?? {}).sort()).toEqual(["chat", "messages"])
  })

  it("**the personal catalogue is pinned**, so moving the personal server onto it changes nothing unseen", async () => {
    const listed = toolsFromCommands(commands(), { exclude: [["bot"]] })
      .map((tool) => `${tool.writes ? "write" : "read "} ${tool.command}`)
      .sort()

    await expect(`${listed.join("\n")}\n`).toMatchFileSnapshot("__snapshots__/personal-catalogue.snap")
  })
})
