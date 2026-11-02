import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Command } from "commander"
import { expect, it } from "vitest"
import { PROVIDERS } from "../domain/providers.js"
import { expected, type Manifest } from "../parity/manifest.js"
import { contactsCommand } from "./messenger/contacts-command.js"
import type { Messenger } from "./messenger/context.js"
import { messagesCommand } from "./messenger/messages-command.js"
import { createProgram } from "./program.js"
import { settingsFor } from "./settings.js"
import { commandAt } from "./steps.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "synthetic", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  chatArgument: "a chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("no connection in this test")
  },
}
const program = createProgram({ app, commands: () => [messagesCommand(messenger), contactsCommand(messenger)] })
const parity = JSON.parse(readFileSync(join(import.meta.dirname, "../../parity.json"), "utf8")) as Manifest

const SAMPLE: Record<string, string> = {
  chat: "chat:chat/1/2",
  message: "msg:chat/1/2/3",
  contact: "contact:chat/7",
}

const opens = PROVIDERS.flatMap(({ name, command, opens = {} }) =>
  command === undefined ? [] : Object.entries(opens).map(([kind, words]) => [name, kind, words] as const),
)

it.each(opens)("%s opens a %s with a command tg, max and wa all have, taking the ref alone", (_, kind, words) => {
  const row = parity.commands[words]
  expect(row).toBeDefined()
  expect(parity.clis.filter((cli) => row !== undefined && expected(row, cli) === false)).toEqual([])
  const command = commandAt(program, words) as Command
  expect(command).toBeDefined()
  const { operands, unknown } = command.parseOptions([SAMPLE[kind] as string])
  expect(unknown).toEqual([])
  expect(operands).toHaveLength(1)
  expect(command.registeredArguments.filter((argument) => argument.required)).toHaveLength(1)
})
