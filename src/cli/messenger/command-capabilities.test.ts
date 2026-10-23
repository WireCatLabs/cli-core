import type { Command } from "commander"
import { describe, expect, it } from "vitest"
import { settingsFor } from "../settings.js"
import { chatsCommand } from "./chats-command.js"
import { markReadCommand } from "./chats-read-command.js"
import type { Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"
import { sendCommand } from "./messages-send-command.js"
import { pollsCommand } from "./polls-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "fixture",
  chatArgument: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("building commands must not connect")
  },
}

const sub = (command: Command, ...path: string[]): Command =>
  path.reduce((found, name) => {
    const next = found.commands.find((one) => one.name() === name)
    if (!next) throw new Error(`no ${name} under ${found.name()}`)
    return next
  }, command)
const flags = (command: Command) => command.options.map((option) => option.long)
const names = (command: Command) => command.commands.map((one) => one.name())

describe("shared commands build only what the messenger has", () => {
  it("offers --topic and topic: only with forum topics", () => {
    const without = { ...messenger, topics: false }
    expect(flags(sendCommand(messenger))).toContain("--topic")
    expect(flags(sendCommand(without))).not.toContain("--topic")
    expect(flags(markReadCommand(without))).not.toContain("--topic")
    expect(flags(sub(pollsCommand(without), "create"))).not.toContain("--topic")
    expect(sub(messagesCommand(messenger), "list").helpInformation()).toContain("topic:")
    expect(sub(messagesCommand(without), "list").helpInformation()).not.toContain("topic:")
  })

  it("refuses topic: in messages list where there are no topics", async () => {
    const list = sub(messagesCommand({ ...messenger, topics: false }), "list")
    list.exitOverride()
    await expect(list.parseAsync(["c", "topic:12"], { from: "user" })).rejects.toThrow(/topic/)
  })

  it("offers --comment-to only where channel posts take comments", () => {
    expect(flags(sendCommand(messenger))).toContain("--comment-to")
    expect(flags(sendCommand({ ...messenger, channelComments: false }))).not.toContain("--comment-to")
  })

  it("leaves out link create and answering every join request where the messenger cannot", () => {
    const limited = chatsCommand({ ...messenger, inviteLinkCreate: false, joinRequestsAll: false })
    expect(names(sub(limited, "links"))).not.toContain("create")
    expect(flags(sub(limited, "requests", "confirm"))).toEqual([])
    expect(sub(limited, "requests", "confirm").registeredArguments[1]?.required).toBe(true)
    expect(flags(sub(chatsCommand(messenger), "requests", "reject"))).toEqual(["--all", "--link"])
  })

  it("answers every join request without --link where the messenger does not say which link a request came by", () => {
    const noLink = chatsCommand({ ...messenger, joinRequestsByLink: false })
    expect(flags(sub(noLink, "requests", "confirm"))).toEqual(["--all"])
    expect(flags(sub(noLink, "requests", "reject"))).toEqual(["--all"])
  })
})
