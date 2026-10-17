import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { StepDefinition } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import { describe, expect, it } from "vitest"
import { REASONS } from "../errors/reasons.js"
import { expected, type Manifest } from "../parity/manifest.js"
import { botCommand } from "./bot/command.js"
import { storeCommand } from "./messenger/archive-commands.js"
import { attachmentsCommand } from "./messenger/attachments-command.js"
import { chatsCommand } from "./messenger/chats-command.js"
import type { Messenger } from "./messenger/context.js"
import { conversationsCommand } from "./messenger/conversations-command.js"
import { doctorCommand } from "./messenger/doctor-command.js"
import { imagesCommand } from "./messenger/images-command.js"
import { inboxCommand } from "./messenger/inbox.js"
import { mcpCommand } from "./messenger/mcp-command.js"
import { mentionsCommand } from "./messenger/mentions-command.js"
import { messagesCommand } from "./messenger/messages-command.js"
import { modelsCommand } from "./messenger/models-command.js"
import { reviewCommand } from "./messenger/review.js"
import { serverCommand } from "./messenger/server-command.js"
import { commandWords, liftProfile } from "./profile.js"
import { createProgram } from "./program.js"
import { settingsFor } from "./settings.js"
import { type CommandStep, commandAt, nextStep, runnable, STEPS, stepLine } from "./steps.js"

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
    imagesCommand(messenger),
    mentionsCommand(messenger),
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
const parity = JSON.parse(readFileSync(join(import.meta.dirname, "../../parity.json"), "utf8")) as Manifest

/** A value of the right kind for each argument, so the line parses as typed. */
const sample = (command: Command, name: string): unknown =>
  command.options.find((option) => option.attributeName() === name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()))
    ?.required ||
  command.options.find((option) => option.long === `--${name.replaceAll("_", "-")}`)?.optional ||
  command.registeredArguments.some((argument) => argument.name() === name)
    ? "7"
    : true

describe("the next-step registry", () => {
  const named = STEPS.filter(
    (step): step is Extract<StepDefinition, { kind: "command" }> => step.kind === "command" && step.command !== "*",
  )

  it.each(named.map((step) => [step.id, step]))("%s names a command every CLI has or plans", (_, step) => {
    const row = parity.commands[step.command]
    const root = parity.commands[step.command.split(" ")[0] as string]
    // A step inside a tree a CLI does not have (wa has no `bot`) is never shown there.
    const reaches = (cli: string) =>
      !row || expected(row, cli) !== false || (root !== undefined && expected(root, cli) === false)
    expect(row).toBeDefined()
    expect(parity.clis.filter((cli) => !reaches(cli))).toEqual([])
    expect(commandAt(program, step.command)).toBeDefined()
  })

  it.each(named.map((step) => [step.id, step]))("%s parses as a person types it", (_, step) => {
    const command = commandAt(program, step.command) as Command
    const args = Object.fromEntries(step.args.map((arg) => [arg.name, sample(command, arg.name)]))
    const line = stepLine(program, nextStep(step.id, { args, values: { shown: 1 } }) as CommandStep)
    const words = line.split(" ").slice(1 + step.command.split(" ").length)
    const { operands, unknown } = command.parseOptions(words)
    expect(unknown).toEqual([])
    expect(operands.length).toBeLessThanOrEqual(command.registeredArguments.length)
  })

  it("puts no positional argument in a step an error names: the error line prints every argument as an option", () => {
    const positional = REASONS.flatMap((reason) => {
      const step = named.find((one) => one.id === reason.step)
      const command = step ? commandAt(program, step.command) : undefined
      return (step?.args ?? [])
        .filter((arg) => command?.registeredArguments.some((argument) => argument.name() === arg.name))
        .map((arg) => `${reason.reason} → ${step?.id}: ${arg.name}`)
    })
    expect(positional).toEqual([])
  })

  it("drops a step whose command this CLI does not have, and keeps at most two", () => {
    const bare = createProgram({ app, commands: () => [messagesCommand(messenger)] })
    const download = nextStep("models.download", { args: { model: "e5-small" } }) as CommandStep
    expect(runnable(bare, [download])).toEqual([])
    expect(runnable(program, [download, download, download])).toHaveLength(2)
    expect(stepLine(program, download)).toBe("chat models text download e5-small")
  })

  it("names the profile the command ran with, so the printed step runs as pasted", () => {
    const withProfile = createProgram({ app, commands: () => [messagesCommand(messenger), modelsCommand(messenger)] })
    withProfile.setOptionValue("profile", "work")
    const line = stepLine(withProfile, nextStep("models.download", { args: { model: "e5-small" } }) as CommandStep)
    expect(line).toBe("chat work models text download e5-small")
    expect(liftProfile(line.split(" ").slice(1), commandWords(withProfile))).toMatchObject({ profile: "work" })
  })

  it("lets a step run unasked only when its command writes nothing to the messenger", () => {
    const sync = nextStep("messages.sync", { args: { chat: "7" } })
    const scheduled = nextStep("messages.scheduled", { args: { chat: "7" } })
    expect([sync, scheduled].map((step) => step.safe_to_auto_execute)).toEqual([false, false])
    expect(runnable(program, [sync, scheduled]).map((step) => step.safe_to_auto_execute)).toEqual([true, true])
    const send: CommandStep = { ...sync, command: "messages send", args: { chat: "7" } } as CommandStep
    expect(runnable(program, [send])[0]?.safe_to_auto_execute).toBe(false)
  })
})
