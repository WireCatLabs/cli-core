import { captureStreams } from "@wirecat/cli-base"
import type { Command } from "commander"
import { describe, expect, it } from "vitest"
import { accountCommand } from "../messenger/account-command.js"
import { storeCommand } from "../messenger/archive-commands.js"
import { attachmentsCommand } from "../messenger/attachments-command.js"
import { chatsCommand } from "../messenger/chats-command.js"
import { contactsCommand } from "../messenger/contacts-command.js"
import type { Messenger } from "../messenger/context.js"
import { conversationsCommand } from "../messenger/conversations-command.js"
import { inboxCommand } from "../messenger/inbox.js"
import { messagesCommand } from "../messenger/messages-command.js"
import { modelsCommand } from "../messenger/models-command.js"
import { pollsCommand } from "../messenger/polls-command.js"
import { reviewCommand } from "../messenger/review.js"
import { searchCommand } from "../messenger/search-command.js"
import { searchesCommand } from "../messenger/searches-command.js"
import { tagsCommand } from "../messenger/tags-command.js"
import { tasksCommand } from "../messenger/tasks-command.js"
import { type ProgramDefinition, run } from "../program.js"
import { settingsFor } from "../settings.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("help never connects")
  },
  chatArgument: "a chat",
}

const commands = () => [
  accountCommand(messenger),
  chatsCommand(messenger),
  contactsCommand(messenger),
  messagesCommand(messenger),
  pollsCommand(messenger),
  modelsCommand(messenger),
  inboxCommand(messenger),
  reviewCommand(messenger),
  storeCommand(messenger),
  conversationsCommand(messenger),
  attachmentsCommand(messenger),
  tagsCommand(messenger),
  tasksCommand(messenger),
  searchCommand(messenger),
  searchesCommand(messenger),
]
const definition: ProgramDefinition = { app, commands }

const paths = (command: Command, path: string[] = []): string[][] => [
  ...(path.length > 0 ? [path] : []),
  ...command.commands.flatMap((sub) => paths(sub, [...path, sub.name()])),
]

describe("--help on a messenger command", () => {
  const all = commands().flatMap((top) => paths(top, [top.name()]))

  it("covers the commands that take a query", () => {
    expect(all).toContainEqual(["tasks", "agenda"])
    expect(all).toContainEqual(["chats", "list"])
  })

  it("prints the command's help and exits 0 for every command", async () => {
    const failed: string[] = []
    for (const path of all) {
      const streams = captureStreams()
      const code = await run(["work", ...path, "--help"], definition, { streams, tty: false, env: {} })
      if (code !== 0 || !streams.stdout.join("\n").includes(`Usage: chat <profile> ${path.join(" ")}`))
        failed.push(`${path.join(" ")}: ${code} ${streams.stderr.join(" ")}`)
    }
    expect(failed).toEqual([])
  })
})
