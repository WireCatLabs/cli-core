import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { appDoctorCommand } from "../cli/app-doctor-command.js"
import { baseContext, environmentOf, outputFor } from "../cli/context.js"
import { REMOTE_READ, REMOTE_WRITE } from "../cli/effects.js"
import { itemOf, renderAnswer } from "../cli/envelope.js"
import type { ProgramDefinition, RunOptions } from "../cli/program.js"
import { settingsFor } from "../cli/settings.js"
import { guardedWrite } from "../sends/guarded.js"
import { newOperationId } from "../sends/send-id.js"
import { neverAnswers, type RunScopeCase, runScopeCases } from "./index.js"

const app = { command: "scope", appName: "scope-cli", envPrefix: "SCOPE", description: "A test CLI", version: "1.0.0" }
const configuration = settingsFor(app)

const answers = (async () => new Response(JSON.stringify({ id: "n1" }))) as typeof fetch
const guard = { check: () => {}, record: () => {} }

const definition = (inRun: boolean): ProgramDefinition => {
  const ask = async (command: Command) => {
    const { fetch } = environmentOf<RunOptions & { fetch: typeof globalThis.fetch }>(command)
    const call = async () => (await fetch("https://notes.example.invalid/n1")).json()
    return inRun ? baseContext(command, configuration.resolveSettings).run(call) : call()
  }
  const answer = (command: Command, value: unknown) => renderAnswer(command, outputFor(command), itemOf(value))
  const show = annotate(new Command("show"), { effects: REMOTE_READ })
    .argument("<id>")
    .action(async function (this: Command) {
      answer(this, await ask(this))
    })
  const add = annotate(new Command("add"), { effects: REMOTE_WRITE }).action(async function (this: Command) {
    const request = { chatId: null, kind: "edit" as const, key: "notes.add", operationId: newOperationId() }
    answer(this, await guardedWrite(guard, request, () => ask(this)))
  })
  return {
    app,
    configuration,
    commands: () => [new Command("notes").addCommand(show).addCommand(add)],
  }
}

const options = (inRun: boolean) => ({
  definition: definition(inRun),
  commands: { "notes show": ["work", "notes", "show", "n1"], "notes add": ["work", "notes", "add"] },
  answering: (): RunOptions => ({ fetch: answers }),
  silent: (): RunOptions => ({ fetch: neverAnswers }),
})

const named = (cases: RunScopeCase[], name: string) => {
  const found = cases.find((one) => one.name.startsWith(name))
  if (!found) throw new Error(`no case ${name}`)
  return found
}

describe("commands that run inside cli-core's run", () => {
  for (const one of runScopeCases(options(true))) it(one.name, () => one.run())
})

describe("the run-scope cases catch a command that runs beside cli-core's run", () => {
  const cases = runScopeCases(options(false))

  it("a read answers under the process run and keeps no run", async () => {
    await expect(named(cases, "notes show runs in a recorded run").run()).rejects.toThrow(/outside a run of its own/)
  })

  it("a write answers under the process run and keeps no run", async () => {
    await expect(named(cases, "notes add runs in a recorded run").run()).rejects.toThrow(/outside a run of its own/)
  })

  it("a remote command with no words and no skip", async () => {
    const partial = runScopeCases({ ...options(true), commands: { "notes show": ["work", "notes", "show", "n1"] } })
    await expect(named(partial, "every remote command").run()).rejects.toThrow(/no words/)
  })
})

describe("doctor --online runs inside cli-core's run", () => {
  const doctor = runScopeCases({
    definition: {
      app,
      configuration,
      commands: () => [appDoctorCommand(app, configuration, { packageName: "@wirecat/scope-cli" })],
    },
    commands: { doctor: ["doctor", "--online"] },
    answering: (): RunOptions => ({ fetch: answers }),
    silent: (): RunOptions => ({ fetch: neverAnswers }),
  })
  for (const one of doctor) it(one.name, () => one.run())
})
