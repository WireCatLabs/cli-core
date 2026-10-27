import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { annotate, describeProgram } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it, vi } from "vitest"
import { runCommandForAgent, toolsFromCommands } from "../mcp/agent.js"
import { configCommand } from "./config-command.js"
import { LOCAL_READ, REMOTE_READ, REMOTE_WRITE } from "./effects.js"
import { commandPathKey, commandPermissions, knownPermissionKeys } from "./permission-keys.js"
import { createProgram, type ProgramDefinition, run } from "./program.js"
import { settingsFor } from "./settings.js"

const app = {
  command: "cal",
  appName: "cal-cli",
  envPrefix: "CAL",
  description: "a calendar",
  version: "1.0.0",
  messenger: false,
}

const fixture = (saved: Record<string, unknown> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "command-permissions-"))
  const env = { CAL_CONFIG_DIR: root, CAL_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "w.db") }
  const file = join(root, "config.json")
  writeFileSync(file, JSON.stringify({ profiles: { work: { permissions: saved } } }))
  const called = vi.fn()
  const configuration = settingsFor(app, {
    permissions: commandPermissions({
      extra: ["api.calendar.calendarList.list", "api.calendar.events.delete"],
      defaults: { "api.calendar.events.delete": "ask" },
    }),
  })
  const definition: ProgramDefinition = {
    app,
    configuration,
    commands: () => [
      configCommand(app, configuration),
      new Command("api")
        .addCommand(annotate(new Command("list").action(called), { effects: LOCAL_READ }))
        .addCommand(annotate(new Command("call").argument("<method>").action(called), { effects: REMOTE_WRITE })),
      new Command("events").addCommand(annotate(new Command("list").action(called), { effects: REMOTE_READ })),
    ],
  }
  const cal = async (...args: string[]) => {
    const streams = captureStreams()
    const code = await run(args, definition, { streams, env, tty: false })
    const failure = streams.stderr.join("\n")
    return {
      code,
      error: failure.startsWith("{") ? (JSON.parse(failure).error as { code: string; message: string }) : undefined,
    }
  }
  const permissions = () => JSON.parse(readFileSync(file, "utf8")).profiles?.work?.permissions
  return { cal, called, definition, configuration, env, permissions }
}

describe("a CLI that declares its own permission keys", () => {
  it("**knows its command paths, their groups and its extra keys**, and none of a messenger's", () => {
    const { definition, configuration } = fixture()
    const known = knownPermissionKeys(createProgram(definition), configuration.permissions)
    for (const key of ["api", "api.call", "events.list", "api.calendar.calendarList.list", "mcp.authority"])
      expect(known.has(key)).toBe(true)
    for (const key of ["messages", "messages.send", "config", "chats.delete"]) expect(known.has(key)).toBe(false)
    expect(commandPathKey(["config", "set"])).toBeNull()
    expect(commandPathKey(["events", "list"])).toBe("events.list")
  })

  it("**saves a key that names a command or group, and refuses one that names none**, listing the ones beside it", async () => {
    const { cal, permissions } = fixture()
    expect((await cal("work", "config", "set", "permissions.api", "deny", "--json")).code).toBe(0)
    expect((await cal("work", "config", "set", "permissions.api.calendar.calendarList.list", "allow")).code).toBe(0)
    expect(permissions()).toEqual({ api: "deny", "api.calendar.calendarList.list": "allow" })

    const typo = await cal("work", "config", "set", "permissions.api.cal", "deny", "--json")
    expect(typo.error?.message).toMatch(
      /permissions\.api\.cal names no command — the known ones there are api\.calendar/,
    )
    const messenger = await cal("work", "config", "set", "permissions.messages.send", "deny", "--json")
    expect(messenger.error?.message).toMatch(/permissions\.messages\.send names no command/)
  })

  it("**refuses a denied command before it runs**, and a write under readonly, but not a read", async () => {
    const { cal, called } = fixture({ api: "deny", events: "readonly" })
    const denied = await cal("work", "api", "list", "--json")
    expect(denied.error).toMatchObject({
      code: "permission_error",
      message: expect.stringContaining("denies api.list"),
    })
    expect((await cal("work", "events", "list")).code).toBe(0)
    expect(called).toHaveBeenCalledTimes(1)
  })

  it("**refuses a write to the service under readonly**", async () => {
    const { cal, called } = fixture({ "api.call": "readonly" })
    const refused = await cal("work", "api", "call", "calendar.events.insert", "--json")
    expect(refused.error).toMatchObject({ code: "permission_error", message: expect.stringContaining("api.call") })
    expect(called).not.toHaveBeenCalled()
  })

  it("**refuses a write under the read-only lock**, whatever the profile allows", async () => {
    const { definition, env, called } = fixture({ api: "allow" })
    const streams = captureStreams()
    await run(["work", "api", "call", "x", "--json"], definition, { streams, env: { ...env, CAL_READ_ONLY: "1" } })
    expect(JSON.parse(streams.stderr.join("")).error.code).toBe("permission_error")
    expect(called).not.toHaveBeenCalled()
  })

  it("**an MCP server's --permission takes the CLI's keys and only tightens**", async () => {
    const { definition, configuration, env, called } = fixture({ "api.call": "readonly" })
    const resolve = (...permission: string[]) => configuration.resolveSettings({ profile: "work", permission }, { env })
    expect(resolve("api=deny", "api.calendar.calendarList.list=readonly").permissions).toMatchObject({
      api: "deny",
      "api.calendar.calendarList.list": "readonly",
    })
    expect(() => resolve("api.call=allow")).toThrow(/would loosen api\.call from readonly/)
    expect(() => resolve("api.calendar.events.delete=allow")).toThrow(
      /would loosen api\.calendar\.events\.delete from ask/,
    )
    expect(() => resolve("api.call=maybe")).toThrow(/e\.g\. api=readonly/)

    const commands = describeProgram(createProgram(definition))
    const program = { commands, run: (argv: string[], given: object) => run(argv, definition, { ...given, env }) }
    const answer = await runCommandForAgent(
      program,
      ["events", "list"],
      {},
      { profile: "work", overrides: ["apx=deny"] },
    )
    expect(answer).toMatchObject({ error: { error: { message: "--permission apx names no command" } } })
    expect(called).not.toHaveBeenCalled()
  })

  it("**a saved key that names no command stops every keyed command**, but `config unset` still removes it", async () => {
    const { cal, called, permissions } = fixture({ apx: "deny" })
    const refused = await cal("work", "events", "list", "--json")
    expect(refused.error).toMatchObject({ code: "configuration_error", message: expect.stringContaining("apx") })
    expect(called).not.toHaveBeenCalled()
    expect((await cal("work", "config", "unset", "permissions.apx")).code).toBe(0)
    expect(permissions()).toBeUndefined()
  })

  it("**over MCP, a denied command is found unavailable and refused**", async () => {
    const { definition, configuration, env, called } = fixture({ api: "deny" })
    const commands = describeProgram(createProgram(definition))
    const levels = () => configuration.resolveSettings({ profile: "work" }, { env }).permissions
    const keyOf = configuration.permissions?.keyOf
    const tools = toolsFromCommands(commands, { includeUnavailable: true, levels: levels(), keyOf })
    expect(tools.find((tool) => tool.command === "api list")?.availability?.()).toEqual({
      available: false,
      reason: "the profile denies api.list",
      permission: "api.list",
    })
    expect(tools.find((tool) => tool.command === "events list")?.availability?.()).toEqual({ available: true })
    const program = { commands, run: (argv: string[], given: object) => run(argv, definition, { ...given, env }) }
    const answer = await runCommandForAgent(program, ["api", "list"], {}, { profile: "work", levels, keyOf })
    expect(answer).toMatchObject({ error: { error: { code: "permission_error" } } })
    expect(called).not.toHaveBeenCalled()
  })
})
