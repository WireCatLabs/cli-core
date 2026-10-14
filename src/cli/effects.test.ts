import { CliError } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import { writes } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import { describe, expect, it } from "vitest"
import { keyForCommand, WRITE_KEYS } from "../sends/permissions.js"
import { botCommand } from "./bot/command.js"
import { commandsCommand } from "./commands-command.js"
import { judgedEffects, judgedTargets } from "./effects.js"
import { accountCommand } from "./messenger/account-command.js"
import { storeCommand } from "./messenger/archive-commands.js"
import { attachmentsCommand } from "./messenger/attachments-command.js"
import { chatsCommand } from "./messenger/chats-command.js"
import { contactsCommand } from "./messenger/contacts-command.js"
import type { Messenger } from "./messenger/context.js"
import { conversationsCommand } from "./messenger/conversations-command.js"
import { doctorCommand } from "./messenger/doctor-command.js"
import { floodCommand } from "./messenger/flood-command.js"
import { recipientsCommand, sendsCommand } from "./messenger/guard-commands.js"
import { imagesCommand } from "./messenger/images-command.js"
import { inboxCommand } from "./messenger/inbox.js"
import { mcpCommand } from "./messenger/mcp-command.js"
import { mentionsCommand } from "./messenger/mentions-command.js"
import { messagesCommand } from "./messenger/messages-command.js"
import { metadataCommand } from "./messenger/metadata-command.js"
import { modelsCommand } from "./messenger/models-command.js"
import { pollsCommand } from "./messenger/polls-command.js"
import { reactionsCommand } from "./messenger/reactions-command.js"
import { repliesCommand } from "./messenger/replies-command.js"
import { reviewCommand } from "./messenger/review.js"
import { scheduleCommand } from "./messenger/schedule-command.js"
import { searchCommand } from "./messenger/search-command.js"
import { searchesCommand } from "./messenger/searches-command.js"
import { serveCommand } from "./messenger/serve-command.js"
import { serverCommand } from "./messenger/server-command.js"
import { statsCommand } from "./messenger/stats-command.js"
import { tagsCommand } from "./messenger/tags-command.js"
import { tasksCommand } from "./messenger/tasks-command.js"
import { topicsCommand } from "./messenger/topics-command.js"
import { watchCommand } from "./messenger/watch-command.js"
import { createProgram } from "./program.js"
import { runsCommand } from "./runs/command.js"
import { settingsFor } from "./settings.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "synthetic", version: "1.0.0" }
const refuse = async (): Promise<never> => {
  throw new CliError("network_error", "no connection in this test")
}
const messenger: Messenger = {
  app,
  provider: "chat",
  chatArgument: "a chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: refuse,
}
const program = createProgram({
  app,
  commands: () => [
    accountCommand(messenger),
    attachmentsCommand(messenger),
    chatsCommand(messenger),
    commandsCommand(app),
    contactsCommand(messenger),
    conversationsCommand(messenger),
    doctorCommand(messenger),
    floodCommand(messenger),
    imagesCommand(messenger),
    inboxCommand(messenger),
    mcpCommand(messenger),
    mentionsCommand(messenger),
    messagesCommand(messenger),
    metadataCommand(messenger),
    modelsCommand(messenger),
    pollsCommand(messenger),
    reactionsCommand(messenger),
    recipientsCommand(messenger),
    repliesCommand(messenger),
    reviewCommand(messenger),
    runsCommand(app),
    scheduleCommand(messenger),
    searchCommand(messenger, { topics: true }),
    searchesCommand(messenger),
    sendsCommand(messenger),
    serveCommand(messenger),
    serverCommand(messenger),
    statsCommand(messenger),
    storeCommand(messenger),
    tagsCommand(messenger),
    tasksCommand(messenger),
    topicsCommand(messenger),
    watchCommand(messenger),
    botCommand({
      app,
      provider: "chat",
      resolveSettings: settingsFor(app).resolveSettings,
      connect: refuse,
      mcp: { program: refuse },
    }),
  ],
})

const runnable = (root: Command): { path: string; command: Command }[] => {
  const found: { path: string; command: Command }[] = []
  const visit = (command: Command, parents: string[]) => {
    const path = [...parents, command.name()]
    if ((command as unknown as { _actionHandler?: unknown })._actionHandler)
      found.push({ path: path.join(" "), command })
    for (const child of command.commands) visit(child, path)
  }
  for (const child of root.commands) visit(child, [])
  return found
}

describe("command effects", () => {
  const commands = runnable(program)

  it("are declared by every command that runs, reads included", () => {
    expect(commands.length).toBeGreaterThan(150)
    expect(commands.filter(({ command }) => !metaOf(command).effects).map(({ path }) => path)).toEqual([])
  })

  it("write somewhere wherever the profile's permissions call the command a write", () => {
    const wrong = commands.filter(({ path, command }) => {
      const key = keyForCommand(path.split(" "))
      const effects = metaOf(command).effects
      return key && WRITE_KEYS.includes(key) && effects && !writes(effects)
    })
    // Reads behind a key a profile must allow: the session list is private, and `conversations embed status`
    // shares the whole `conversations.embed` group's key (FIND-1262).
    expect(wrong.map(({ path }) => path)).toEqual(["account sessions list", "conversations embed status"])
  })

  it("judge retry and unasked steps on the remote side only", () => {
    expect(judgedEffects({ remote: "read", local: "write" })).toEqual({ remote: "read", local: "none" })
    expect(judgedEffects(undefined)).toBeUndefined()
    const targets = judgedTargets(program)
    expect(targets("messages sync")?.effects).toEqual({ remote: "read", local: "none" })
    expect(targets("messages send")?.effects).toEqual({ remote: "write", local: "none" })
  })
})
