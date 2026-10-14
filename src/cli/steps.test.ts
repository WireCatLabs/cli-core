import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Command } from "commander"
import { describe, expect, it } from "vitest"
import { botCommand } from "./bot/command.js"
import { storeCommand } from "./messenger/archive-commands.js"
import { attachmentsCommand } from "./messenger/attachments-command.js"
import { chatsCommand } from "./messenger/chats-command.js"
import type { Messenger } from "./messenger/context.js"
import { conversationsCommand } from "./messenger/conversations-command.js"
import { doctorCommand } from "./messenger/doctor-command.js"
import { inboxCommand } from "./messenger/inbox.js"
import { mcpCommand } from "./messenger/mcp-command.js"
import { messagesCommand } from "./messenger/messages-command.js"
import { modelsCommand } from "./messenger/models-command.js"
import { reviewCommand } from "./messenger/review.js"
import { serverCommand } from "./messenger/server-command.js"
import { createProgram } from "./program.js"
import { REASONS } from "./reasons.js"
import { settingsFor } from "./settings.js"
import { commandAt, nextStep, runnable, STEPS, stepLine } from "./steps.js"

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
const program = createProgram({
  app,
  commands: () => [
    chatsCommand(messenger),
    messagesCommand(messenger),
    modelsCommand(messenger),
    inboxCommand(messenger),
    reviewCommand(messenger),
    storeCommand(messenger),
    attachmentsCommand(messenger),
    conversationsCommand(messenger),
    doctorCommand(messenger),
    mcpCommand(messenger),
    serverCommand(messenger),
    botCommand({
      app,
      provider: "chat",
      resolveSettings: settingsFor(app).resolveSettings,
      connect: async () => {
        throw new Error("no connection in this test")
      },
      mcp: {
        program: async () => {
          throw new Error("no server in this test")
        },
      },
    }),
  ],
})
const parity = JSON.parse(readFileSync(join(import.meta.dirname, "../../parity.json"), "utf8")) as {
  commands: Record<string, { in: unknown }>
}

/** A value of the right kind for each argument, so the line parses as typed. */
const sample = (command: Command, name: string): unknown =>
  command.options.find((option) => option.attributeName() === name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()))
    ?.required ||
  command.options.find((option) => option.long === `--${name.replaceAll("_", "-")}`)?.optional ||
  command.registeredArguments.some((argument) => argument.name() === name)
    ? "7"
    : true

describe("the next-step registry", () => {
  const named = STEPS.filter((step) => step.command !== "*")

  it.each(named.map((step) => [step.id, step]))("%s names a command tg and max both have", (_, step) => {
    expect(parity.commands[step.command]?.in).toBe("all")
    expect(commandAt(program, step.command)).toBeDefined()
  })

  it.each(named.map((step) => [step.id, step]))("%s parses as a person types it", (_, step) => {
    const command = commandAt(program, step.command) as Command
    const args = Object.fromEntries(step.args.map((arg) => [arg.name, sample(command, arg.name)]))
    const line = stepLine(program, nextStep(step.id, { args, values: { shown: 1 } }))
    const words = line.split(" ").slice(1 + step.command.split(" ").length)
    const { operands, unknown } = command.parseOptions(words)
    expect(unknown).toEqual([])
    expect(operands.length).toBeLessThanOrEqual(command.registeredArguments.length)
  })

  it("puts no positional argument in a step an error names: the error line prints every argument as an option", () => {
    const positional = REASONS.flatMap((reason) => {
      const step = STEPS.find((one) => one.id === reason.step)
      const command = step && step.command !== "*" ? commandAt(program, step.command) : undefined
      return (step?.args ?? [])
        .filter((arg) => command?.registeredArguments.some((argument) => argument.name() === arg.name))
        .map((arg) => `${reason.reason} → ${step?.id}: ${arg.name}`)
    })
    expect(positional).toEqual([])
  })

  it("drops a step whose command this CLI does not have, and keeps at most three", () => {
    const bare = createProgram({ app, commands: () => [messagesCommand(messenger)] })
    const download = nextStep("models.download", { args: { model: "e5-small" } })
    expect(runnable(bare, [download])).toEqual([])
    expect(runnable(program, [download])).toEqual([download])
    expect(runnable(program, [download, download, download, download])).toHaveLength(3)
    expect(stepLine(program, download)).toBe("chat models text download e5-small")
  })
})
