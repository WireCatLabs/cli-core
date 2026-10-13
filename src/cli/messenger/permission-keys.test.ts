import type { Command } from "commander"
import { describe, expect, it } from "vitest"
import { keyForCommand } from "../../sends/permissions.js"
import { commandsCommand } from "../commands-command.js"
import { configCommand } from "../config-command.js"
import { runsCommand } from "../runs/command.js"
import { settingsFor } from "../settings.js"
import { accountCommand } from "./account-command.js"
import { storeCommand } from "./archive-commands.js"
import { attachmentsCommand } from "./attachments-command.js"
import { chatsCommand } from "./chats-command.js"
import { completeCommand } from "./complete-command.js"
import { contactsCommand } from "./contacts-command.js"
import type { Messenger } from "./context.js"
import { conversationsCommand } from "./conversations-command.js"
import { doctorCommand } from "./doctor-command.js"
import { recipientsCommand, sendsCommand } from "./guard-commands.js"
import { inboxCommand } from "./inbox.js"
import { mcpCommand } from "./mcp-command.js"
import { messagesCommand } from "./messages-command.js"
import { modelsCommand } from "./models-command.js"
import { pollsCommand } from "./polls-command.js"
import { reactionsCommand } from "./reactions-command.js"
import { reviewCommand } from "./review.js"
import { searchesCommand } from "./searches-command.js"
import { serveCommand } from "./serve-command.js"
import { serverCommand } from "./server-command.js"
import { statsCommand } from "./stats-command.js"
import { tagsCommand } from "./tags-command.js"
import { topicsCommand } from "./topics-command.js"
import { watchCommand } from "./watch-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("never connects")
  },
  chatArgument: "a chat",
}

const leaves = (command: Command, path: string[] = []): string[][] =>
  command.commands.length === 0 ? [path] : command.commands.flatMap((sub) => leaves(sub, [...path, sub.name()]))

describe("the permission key of a command", () => {
  it("offers daily roster tracking only when the CLI's background service implements it", () => {
    const fetchOf = (picked: Messenger) =>
      chatsCommand(picked)
        .commands.find((one) => one.name() === "members")
        ?.commands.find((one) => one.name() === "fetch")
    expect(fetchOf(messenger)?.options.map((one) => one.long)).toContain("--track")
    const native = fetchOf({ ...messenger, tracksMembers: false })
    expect(native?.options.map((one) => one.long)).not.toContain("--track")
    expect(native?.options.map((one) => one.long)).toContain("--budget")
  })

  it("**names every shared command**, so a level cannot be walked around", () => {
    const commands = [
      accountCommand(messenger),
      chatsCommand(messenger),
      contactsCommand(messenger),
      messagesCommand(messenger),
      reactionsCommand(messenger),
      pollsCommand(messenger),
      topicsCommand(messenger),
      inboxCommand(messenger),
      reviewCommand(messenger),
      watchCommand(messenger),
      serveCommand(messenger),
      serverCommand(messenger),
      storeCommand(messenger),
      conversationsCommand(messenger),
      statsCommand(messenger),
      tagsCommand(messenger),
      attachmentsCommand(messenger),
      searchesCommand(messenger),
      recipientsCommand(messenger),
      sendsCommand(messenger),
      modelsCommand(messenger),
      mcpCommand(messenger),
      doctorCommand(messenger),
      completeCommand(messenger, settingsFor(app)),
      configCommand(app, settingsFor(app)),
      commandsCommand(app),
      runsCommand(app),
    ]
    const paths = commands.flatMap((command) => leaves(command, [command.name()]))

    expect(paths.filter((path) => keyForCommand(path) === undefined)).toEqual([])
    expect(keyForCommand(["store", "export"])).toBe("messages")
    expect(keyForCommand(["messages", "sync"])).toBe("messages")
    expect(keyForCommand(["conversations", "show"])).toBe("messages")
    expect(keyForCommand(["conversations", "links", "add"])).toBe("conversations.links")
    expect(keyForCommand(["conversations", "embed"])).toBe("conversations.embed")
    expect(keyForCommand(["conversations", "embed", "clear"])).toBe("conversations.embed")
    expect(keyForCommand(["store", "backup"])).toBeNull()
    expect(keyForCommand(["chats", "members", "list"])).toBe("chats.members.list")
    expect(keyForCommand(["tags", "add"])).toBe("tags.add")
    expect(keyForCommand(["attachments", "extract"])).toBe("attachments.extract")
    expect(keyForCommand(["attachments", "text", "set"])).toBe("attachments.text.set")
    expect(keyForCommand(["attachments", "list"])).toBe("messages")
    expect(keyForCommand(["chats", "documents", "list"])).toBe("messages")
    expect(keyForCommand(["searches", "history"])).toBe("searches.history")
  })
})
