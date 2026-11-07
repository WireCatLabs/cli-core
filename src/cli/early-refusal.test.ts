import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { annotate, describeProgram } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it, vi } from "vitest"
import { runCommandForAgent } from "../mcp/agent.js"
import { REMOTE_READ, REMOTE_WRITE } from "./effects.js"
import { commandPermissions } from "./permission-keys.js"
import { createProgram, type ProgramDefinition, run } from "./program.js"
import { settingsFor } from "./settings.js"

const fixture = (messenger: boolean) => {
  const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "a test CLI", version: "1.0.0" }
  const identity = messenger ? app : { ...app, messenger: false as const }
  const root = mkdtempSync(join(tmpdir(), "early-refusal-"))
  const env = { APP_CONFIG_DIR: root, APP_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "w.db") }
  writeFileSync(join(root, "config.json"), JSON.stringify({ profiles: { work: {} } }))
  const called = vi.fn()
  const definition: ProgramDefinition = {
    app: identity,
    configuration: messenger ? settingsFor(identity) : settingsFor(identity, { permissions: commandPermissions() }),
    commands: () => [
      new Command("messages")
        .addCommand(annotate(new Command("send").action(called), { effects: REMOTE_WRITE }))
        .addCommand(annotate(new Command("list").action(called), { effects: REMOTE_READ })),
    ],
  }
  const program = {
    commands: describeProgram(createProgram(definition)),
    run: (argv: string[], given: object) => run(argv, definition, { ...given, env }),
  }
  const asAgent = (command: string, overrides: string[]) =>
    runCommandForAgent(program, command.split(" "), {}, { profile: "work", overrides })
  return { asAgent, called }
}

const refused = { error: { error: { code: "permission_error" } } }

describe("an MCP server's --permission levels refuse a command before it runs", () => {
  it("a messenger's write", async () => {
    const { asAgent, called } = fixture(true)
    expect(await asAgent("messages send", ["messages.send=deny"])).toMatchObject(refused)
    expect(called).not.toHaveBeenCalled()
  })

  it("a keyed CLI's write and read", async () => {
    const { asAgent, called } = fixture(false)
    expect(await asAgent("messages send", ["messages.send=deny"])).toMatchObject(refused)
    expect(await asAgent("messages list", ["messages.list=deny"])).toMatchObject(refused)
    expect(called).not.toHaveBeenCalled()
  })
})
