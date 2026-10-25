import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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
  return { code, answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]).item : undefined, stderr: streams.stderr }
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

  it("**removes a saved key no command checks** with unset, and refuses to save one", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state") }
    await call(["work", "config", "set", "region", "eu"], env)
    const file = join(env.CHAT_CONFIG_DIR, "config.json")
    const saved = JSON.parse(readFileSync(file, "utf8"))
    saved.profiles.work.permissions = { "models.nicknames": "deny" }
    writeFileSync(file, JSON.stringify(saved))

    expect((await call(["work", "config", "show", "--json"], env)).code).toBe(0)
    expect((await call(["work", "config", "set", "permissions.models.voices", "deny"], env)).code).toBe(2)
    expect((await call(["work", "config", "set", "permissions.models", "deny"], env)).code).toBe(0)
    expect((await call(["work", "config", "unset", "permissions.models.nicknames"], env)).code).toBe(0)
    expect(JSON.parse(readFileSync(file, "utf8")).profiles.work.permissions).toEqual({ models: "deny" })
  })

  it("refuses to change every profile from a process locked to one", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_PROFILE_LOCK: "work" }

    expect((await call(["config", "set", "limit", "5", "--defaults"], env)).code).toBe(5)
  })

  it("**removes a top-level key no schema knows** with an unset that names no profile, and only such a key", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
    await call(["home", "config", "set", "limit", "6"], env)
    const refused = await call(["home", "config", "set", "default_profile", "home"], env)
    expect(refused.code).toBe(2)
    expect(refused.stderr.join("\n")).toContain('no setting called \\"default_profile\\"')

    const file = join(env.CHAT_CONFIG_DIR, "config.json")
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), default_profile: "home" }))
    expect((await call(["config", "unset", "limit"], env)).code).toBe(2)
    expect((await call(["config", "unset", "default_profile", "--json"], env)).answer).toMatchObject({
      scope: "file",
      value: null,
    })
    const saved = JSON.parse(readFileSync(file, "utf8"))
    expect(saved.default_profile).toBeUndefined()
    expect(saved.profiles).toEqual({ home: { limit: 6 } })
  })

  it("**shows, sets and unsets on a file with problems**, leaving the others for their own unset", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    const file = join(env.CHAT_CONFIG_DIR, "config.json")
    const broken = { permissions: { "bogus.thing": "deny", "messages.bogus": "deny" }, limitt: 1, color: "yes" }
    writeFileSync(file, JSON.stringify({ profiles: { work: broken } }))

    const shown = await call(["work", "config", "show", "--json"], env)
    expect(shown.code).toBe(0)
    expect(shown.stderr.join("\n")).toContain("`chat work config unset permissions.bogus.thing` removes it")
    expect(shown.stderr.join("\n")).toContain("`chat work config unset permissions.messages.bogus` removes it")
    expect((await call(["work", "config", "set", "limit", "5"], env)).code).toBe(0)
    expect((await call(["work", "config", "set", "color", "maybe"], env)).code).toBe(2)
    expect((await call(["work", "config", "set", "color", "true"], env)).code).toBe(0)
    expect(JSON.parse(readFileSync(file, "utf8")).profiles.work).toEqual({ ...broken, color: true, limit: 5 })

    for (const key of ["permissions.bogus.thing", "permissions.messages.bogus", "limitt"])
      expect((await call(["work", "config", "unset", key], env)).code).toBe(0)
    expect(JSON.parse(readFileSync(file, "utf8")).profiles.work).toEqual({ color: true, limit: 5 })
  })

  it("refuses a top-level unset from a process locked to one profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_PROFILE_LOCK: "work" }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify({ default_profile: "work" }))

    expect((await call(["config", "unset", "default_profile"], env)).code).toBe(5)
    expect(JSON.parse(readFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), "utf8"))).toEqual({
      default_profile: "work",
    })
  })

  it("**refuses every change under the read-only lock**, and still shows the settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_PROFILE: "work", CHAT_READ_ONLY: "1" }

    expect((await call(["config", "set", "permissions.messages.send", "allow"], env)).code).toBe(5)
    expect((await call(["config", "set", "limit", "5", "--defaults"], env)).code).toBe(5)
    expect((await call(["config", "unset", "permissions.messages.send"], env)).code).toBe(5)
    expect(existsSync(join(root, "config"))).toBe(false)
    expect((await call(["config", "show", "--json"], env)).code).toBe(0)
  })
})
