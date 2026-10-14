import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { configCommand } from "./config-command.js"
import { run } from "./program.js"
import { settingsFor } from "./settings.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const config = settingsFor(app, { profile: { region: v.optional(v.string()) } })

const call = async (argv: string[], env: NodeJS.ProcessEnv) => {
  const streams = captureStreams()
  const code = await run(argv, { app, commands: () => [configCommand(app, config)] }, { streams, tty: false, env })
  return { code, answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]).item : undefined }
}

describe("config", () => {
  it("**saves a setting, shows where it came from, and removes it again** — a messenger's own included", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state") }
    const setting = async (name: string) =>
      (await call(["work", "config", "show", "--json"], env)).answer.settings.find(
        (one: { setting: string }) => one.setting === name,
      )

    expect((await call(["work", "config", "set", "limit", "5", "--json"], env)).answer).toMatchObject({
      scope: "profiles.work",
      value: 5,
    })
    await call(["work", "config", "set", "region", "eu"], env)

    const shown = await call(["work", "config", "show", "--json"], env)
    expect(shown.answer.profiles).toEqual(["work"])
    expect(shown.answer.settings).toEqual(
      expect.arrayContaining([
        { setting: "limit", value: 5, from: "config file" },
        { setting: "region", value: "eu", from: "config file" },
      ]),
    )
    await call(["work", "config", "unset", "limit"], env)
    expect(await setting("limit")).toMatchObject({ value: 20, from: "config defaults" })
  })

  it("answers a camelCase name with the snake_case setting it saved", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state") }

    expect((await call(["work", "config", "set", "keepRunsForDays", "7", "--json"], env)).answer).toMatchObject({
      setting: "keep_runs_for_days",
      value: 7,
    })
  })

  it("**shows the permissions in force**, from every section, not only the profile's own", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state") }
    await call(["work", "config", "set", "permissions.messages", "readonly"], env)
    await call(["config", "set", "permissions.contacts", "deny", "--defaults"], env)

    const shown = (await call(["work", "config", "show", "--json"], env)).answer.settings
    expect(shown.find((one: { setting: string }) => one.setting === "permissions")).toEqual({
      setting: "permissions",
      value: { messages: "readonly", contacts: "deny" },
      from: "config file",
      sources: { messages: "config file", contacts: "config defaults" },
    })
  })

  it("**refuses a permission key that names no command**, and still removes one", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state") }
    const streams = captureStreams()
    const refused = await run(
      ["config", "set", "permissions.messages.dlete", "allow"],
      { app, commands: () => [configCommand(app, config)] },
      { streams, tty: false, env },
    )
    expect(refused).toBe(2)
    expect(streams.stderr.join("\n")).toMatch(/permissions\.messages\.dlete names no command — .*messages\.delete/)

    expect(
      (await call(["config", "set", "permissions", '{"messages":"readonly","messages.dlete":"allow"}'], env)).code,
    ).toBe(2)
    expect((await call(["config", "set", "permissions.messages.delete", "allow"], env)).code).toBe(0)
    expect((await call(["config", "unset", "permissions.messages.dlete"], env)).code).toBe(0)
  })

  it("refuses to change every profile from a process locked to one", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_PROFILE_LOCK: "work" }

    expect((await call(["config", "set", "limit", "5", "--defaults"], env)).code).toBe(5)
  })

  it("**sets, shows and unsets default_profile without naming a profile**", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
    await call(["work", "config", "set", "limit", "5"], env)
    await call(["home", "config", "set", "limit", "6"], env)

    expect((await call(["config", "set", "default_profile", "home", "--json"], env)).answer).toMatchObject({
      scope: "default_profile",
      value: "home",
    })
    const shown = (await call(["config", "show", "--json"], env)).answer.settings
    expect(shown.find((one: { setting: string }) => one.setting === "default_profile")).toEqual({
      setting: "default_profile",
      value: "home",
      from: "config file",
    })
    expect((await call(["config", "set", "default_profile", "home", "--defaults"], env)).code).toBe(2)

    expect((await call(["config", "unset", "default_profile", "--json"], env)).answer).toMatchObject({ value: null })
    const after = (await call(["config", "show", "--json"], env)).answer.settings
    expect(after.find((one: { setting: string }) => one.setting === "default_profile")).toMatchObject({ value: null })
  })

  it("refuses to change default_profile from a process locked to one profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_PROFILE_LOCK: "work" }

    expect((await call(["config", "set", "default_profile", "home"], env)).code).toBe(5)
  })

  it("**refuses every change under the read-only lock**, and still shows the settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_PROFILE: "work", CHAT_READ_ONLY: "1" }

    expect((await call(["config", "set", "permissions.messages.send", "allow"], env)).code).toBe(5)
    expect((await call(["config", "set", "read_only", "false", "--defaults"], env)).code).toBe(5)
    expect((await call(["config", "unset", "allow"], env)).code).toBe(5)
    expect((await call(["config", "migrate"], env)).code).toBe(5)
    expect(existsSync(join(root, "config"))).toBe(false)
    expect((await call(["config", "show", "--json"], env)).answer.settings).toEqual(
      expect.arrayContaining([{ setting: "read_only", value: true, from: "CHAT_READ_ONLY" }]),
    )
  })
})
