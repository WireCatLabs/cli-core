import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { fakeAdapter } from "../../kit/fake.js"
import { commandCapabilities } from "../../ports/capabilities.js"
import { settingsFor } from "../settings.js"
import { markReadCommand } from "./chats-read-command.js"
import type { Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"
import { deleteCommand } from "./messages-delete-command.js"
import { forwardCommand } from "./messages-forward-command.js"
import { sendCommand } from "./messages-send-command.js"
import { pollsCommand } from "./polls-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "test", version: "1.0.0" }
const provider = (own: Partial<Messenger> = {}): Messenger => ({
  app,
  provider: "chat",
  chatArgument: "a chat",
  connect: async () => fakeAdapter(),
  resolveSettings: settingsFor(app).resolveSettings,
  ...own,
})
const optionNames = (command: Command) => command.options.map((option) => option.attributeName())

describe("provider command construction", () => {
  it("preserves existing topic/comment defaults and Telegram media options", () => {
    const messenger = provider({ mediaOptions: ["spoiler", "captionAbove", "fileName"], forwardTopic: true })
    expect(optionNames(sendCommand(messenger))).toEqual(
      expect.arrayContaining(["topic", "commentTo", "spoiler", "captionAbove", "filename"]),
    )
    expect(optionNames(forwardCommand(messenger))).toContain("topic")
    const messages = messagesCommand(messenger)
    expect(optionNames(messages.commands.find((command) => command.name() === "list") as Command)).toContain("topic")
    expect(messages.commands.some((command) => command.name() === "comments")).toBe(true)
  })

  it("constructs MAX topic-free commands without changing completed Commander objects", () => {
    const messenger = provider({ topics: false, comments: false, stickers: true })
    expect(optionNames(sendCommand(messenger))).not.toEqual(expect.arrayContaining(["topic", "commentTo"]))
    for (const option of ["topic", "commentTo", "spoiler", "captionAbove"]) {
      expect(optionNames(sendCommand(messenger))).not.toContain(option)
    }
    expect(optionNames(sendCommand(messenger))).toContain("sticker")
    expect(optionNames(markReadCommand(messenger))).not.toContain("topic")
    const polls = pollsCommand(messenger)
    expect(optionNames(polls.commands.find((command) => command.name() === "create") as Command)).not.toContain("topic")
    const messages = messagesCommand(messenger)
    expect(optionNames(messages.commands.find((command) => command.name() === "list") as Command)).not.toContain(
      "topic",
    )
    expect(messages.commands.some((command) => command.name() === "comments")).toBe(false)
  })

  it("declares comma-separated message syntax before parsing while preserving the default", async () => {
    const parse = async (own: Partial<Messenger>) => {
      let parsed: string[] = []
      const command = deleteCommand(provider(own)).action((_chat: string, messages: string[]) => {
        parsed = messages
      })
      await new Command().addCommand(command).parseAsync(["delete", "7", "1,2", "3"], { from: "user" })
      return parsed
    }
    expect(await parse({ commaSeparatedMessageIds: true })).toEqual(["1", "2", "3"])
    expect(await parse({})).toEqual(["1,2", "3"])
  })

  it("normalizes opt-in and opt-out capabilities once", () => {
    expect(commandCapabilities(provider())).toMatchObject({
      topics: true,
      comments: true,
      privacy: false,
      folderJoin: true,
      addsWithHistory: true,
    })
  })
})
