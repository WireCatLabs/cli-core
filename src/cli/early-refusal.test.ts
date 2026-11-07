import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { annotate, describeProgram } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it, vi } from "vitest"
import { runCommandForAgent } from "../mcp/agent.js"
import { refuseOffline } from "./early-refusal.js"
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

describe("--offline and a command that needs the service", () => {
  const app = { command: "crm", appName: "crm-cli", envPrefix: "CRM", description: "a test CLI", version: "1.0.0" }

  const offlineRun = async (argv: string[]) => {
    const root = mkdtempSync(join(tmpdir(), "offline-refusal-"))
    const called = vi.fn()
    const leaf = (name: string, meta: object) => annotate(new Command(name), { effects: REMOTE_READ, ...meta })
    const definition: ProgramDefinition = {
      app,
      commands: () => [
        new Command("deals")
          .addCommand(leaf("list", {}).action(() => called("list")))
          .addCommand(
            leaf("move", { offline: false })
              .option("--dry-run", "preview")
              .action(() => called("move")),
          )
          .addCommand(
            leaf("check", {})
              .option("--check", "ask the service")
              .action(function (this: Command) {
                if (this.opts().check) refuseOffline(this, "the CRM")
                called("check")
              }),
          ),
        annotate(new Command("fields"), { offline: false }).addCommand(
          leaf("refresh", {}).action(() => called("refresh")),
        ),
      ],
    }
    const streams = captureStreams()
    const code = await run([...argv, "--json", "--no-record"], definition, {
      streams,
      tty: false,
      env: { CRM_CONFIG_DIR: root, CRM_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "w.db") },
    })
    const error = streams.stderr.length ? JSON.parse(streams.stderr.at(-1) ?? "{}").error : undefined
    return { code, called, error }
  }

  const OFFLINE_REFUSED = { code: "permission_error", reason: "offline.refused" }

  it("refuses a command annotated offline: false before its action runs", async () => {
    const { called, error } = await offlineRun(["deals", "move", "--offline"])
    expect(error).toMatchObject({ ...OFFLINE_REFUSED, message: expect.stringContaining("`crm deals move`") })
    expect(called).not.toHaveBeenCalled()
  })

  it("refuses a subcommand of a group annotated offline: false", async () => {
    const { called, error } = await offlineRun(["fields", "refresh", "--offline"])
    expect(error).toMatchObject(OFFLINE_REFUSED)
    expect(called).not.toHaveBeenCalled()
  })

  it("lets the command's own --dry-run through, and every command without --offline", async () => {
    for (const argv of [
      ["deals", "move", "--offline", "--dry-run"],
      ["deals", "move"],
      ["deals", "list", "--offline"],
    ]) {
      const { code, called } = await offlineRun(argv)
      expect(code).toBe(0)
      expect(called).toHaveBeenCalledOnce()
    }
  })

  it("refuseOffline refuses where the need depends on a flag", async () => {
    expect((await offlineRun(["deals", "check", "--offline"])).code).toBe(0)
    const { called, error } = await offlineRun(["deals", "check", "--check", "--offline"])
    expect(error).toMatchObject({ ...OFFLINE_REFUSED, message: "this needs the CRM; leave out --offline" })
    expect(called).not.toHaveBeenCalled()
  })
})
