import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { openCache, ownerLanguages } from "../store/index.js"
import { commandsCommand } from "./commands-command.js"
import { configCommand } from "./config-command.js"
import { changesAuthorityAt } from "./effects.js"
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
  it("**a CLI that is not a messenger shows no --bot or --personal**, and show names kind and permissions as a messenger's does", async () => {
    const tool = { ...app, messenger: false }
    const own = settingsFor(tool)
    const longs = (name: string, of = app) =>
      configCommand(of, of === app ? config : own)
        .commands.find((one) => one.name() === name)
        ?.options.filter((option) => !option.hidden)
        .map((option) => option.long)
    for (const name of ["show", "set", "unset"]) {
      expect(longs(name, tool)).not.toContain("--bot")
      expect(longs(name, tool)).not.toContain("--personal")
    }
    expect(longs("show")).toContain("--bot")
    expect(longs("set")).toEqual(expect.arrayContaining(["--personal", "--bot"]))

    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
    const streams = captureStreams()
    const code = await run(
      ["work", "config", "show", "--json"],
      { app: tool, commands: () => [configCommand(tool, own)] },
      { streams, tty: false, env },
    )
    expect(code).toBe(0)
    const { item } = JSON.parse(streams.stdout[0] ?? "{}")
    expect(item).toMatchObject({ kind: "personal", permissions: {}, permission_sources: {} })
    expect(streams.stderr.join("\n")).toContain("a sign-in made with them is kept apart")
    const old = captureStreams()
    const stillTaken = await run(
      ["work", "config", "show", "--bot", "--json"],
      { app: tool, commands: () => [configCommand(tool, own)] },
      { streams: old, tty: false, env },
    )
    expect(stillTaken).toBe(0)
  })

  it("**a CLI that is not a messenger but sends** offers sends_per_hour and reads it", async () => {
    const tool = { ...app, messenger: false, sends: true as const }
    const own = settingsFor(tool)
    const offered = (
      configCommand(tool, own).commands.find((one) => one.name() === "set")?.registeredArguments[0]?.description ?? ""
    ).split(", ")
    expect(offered).toContain("sends_per_hour")
    expect(offered).not.toContain("sender_colors")
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
    const streams = captureStreams()
    const code = await run(
      ["work", "config", "set", "sends_per_hour", "5", "--json"],
      { app: tool, commands: () => [configCommand(tool, own)] },
      { streams, tty: false, env },
    )
    expect(code, streams.stderr.join("\n")).toBe(0)
    expect(own.resolveSettings({ profile: "work" }, { env }).sendsPerHour).toBe(5)
  })

  it("**a CLI that is not a messenger offers no messenger setting**, and refuses one", async () => {
    const tool = { ...app, messenger: false }
    const own = settingsFor(tool)
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
    const offered = (
      configCommand(tool, own).commands.find((one) => one.name() === "set")?.registeredArguments[0]?.description ?? ""
    )
      .replace("one of: ", "")
      .split(", ")
    expect(offered).toEqual(expect.arrayContaining(["limit", "search_stemmers.latin"]))
    const messengers = [
      "sends_per_hour",
      "sender_colors",
      "phone_countries",
      "task_agent_close",
      "read_other_bots",
      "speech_model",
      "picture_search",
      "history_muted",
    ]
    for (const setting of messengers) expect(offered).not.toContain(setting)
    expect(offered.some((setting) => setting.startsWith("task_") || setting.startsWith("account_groups"))).toBe(false)

    for (const [setting, value] of [
      ["sends_per_hour", "5"],
      ["phone_countries", "ES"],
    ]) {
      const streams = captureStreams()
      const code = await run(
        ["work", "config", "set", setting as string, value as string, "--json"],
        { app: tool, commands: () => [configCommand(tool, own)] },
        { streams, tty: false, env },
      )
      expect(code).toBe(2)
      expect(JSON.parse(streams.stderr[0] ?? "{}").error.message).toContain(`no setting called "${setting}"`)
    }

    const shown = captureStreams()
    await run(
      ["work", "config", "show", "--json"],
      { app: tool, commands: () => [configCommand(tool, own)] },
      { streams: shown, tty: false, env: { ...env, MESSAGING_STORE: join(root, "w.db") } },
    )
    const { item } = JSON.parse(shown.stdout.join("")) as {
      item: { settings: { setting: string }[]; store_settings: { setting: string }[] }
    }
    const listed = [...item.settings, ...item.store_settings].map(({ setting }) => setting)
    expect(listed).toEqual(expect.arrayContaining(["limit"]))
    for (const setting of listed)
      expect(messengers.includes(setting) || /^task_(categories|agent_close|first_pass)/u.test(setting)).toBe(false)
  })

  it("**owner_languages is store-wide in every CLI**: an ordered list without repeats, ru when unset", async () => {
    const tool = { ...app, messenger: false }
    const own = settingsFor(tool)
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = {
      CHAT_CONFIG_DIR: join(root, "config"),
      CHAT_STATE_DIR: join(root, "state"),
      MESSAGING_STORE: join(root, "w.db"),
    }
    const call = async (...argv: string[]) => {
      const streams = captureStreams()
      const code = await run(
        ["work", "config", ...argv, "--json"],
        { app: tool, commands: () => [configCommand(tool, own)] },
        { streams, tty: false, env },
      )
      return { code, item: streams.stdout[0] ? JSON.parse(streams.stdout[0]).item : undefined, stderr: streams.stderr }
    }
    const read = async () => {
      const database = await openCache(env.MESSAGING_STORE)
      try {
        return ownerLanguages(database)
      } finally {
        database.close()
      }
    }

    const set = await call("set", "owner_languages", "EN, ru,en")
    expect(set.code, set.stderr.join("\n")).toBe(0)
    expect(set.item).toMatchObject({ scope: "store", setting: "owner_languages", value: "en,ru" })
    expect(await read()).toEqual(["en", "ru"])
    expect((await call("show")).item.store_settings).toContainEqual({
      setting: "owner_languages",
      value: "en,ru",
      from: "store",
      scope: "store",
    })

    const refused = await call("set", "owner_languages", "ru,xx")
    expect(refused.code).toBe(2)
    expect(JSON.parse(refused.stderr[0] ?? "{}").error).toMatchObject({ code: "validation_error" })
    expect(refused.stderr.join("\n")).toContain("not xx")
    expect(await read()).toEqual(["en", "ru"])

    expect((await call("unset", "owner_languages")).item).toMatchObject({ value: "ru" })
    expect(await read()).toEqual(["ru"])
    expect((await call("show")).item.store_settings).toContainEqual({
      setting: "owner_languages",
      value: "ru",
      from: "default",
      scope: "store",
    })
  })

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
        expect.objectContaining({ setting: "limit", value: 5, from: "config file", default: 20 }),
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

  it("sets how runs are kept: record_input true, false or failed, and the success horizon", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config") }
    const file = join(env.CHAT_CONFIG_DIR, "config.json")
    expect((await call(["work", "config", "set", "record_input", "failed"], env)).code).toBe(0)
    expect((await call(["work", "config", "set", "keep_successful_runs_for_days", "3"], env)).code).toBe(0)
    expect((await call(["work", "config", "set", "runs_size_limit_mb", "50"], env)).code).toBe(0)
    expect((await call(["work", "config", "set", "record_input", "sometimes"], env)).code).toBe(2)
    expect(JSON.parse(readFileSync(file, "utf8")).profiles.work).toMatchObject({
      record_input: "failed",
      keep_successful_runs_for_days: 3,
      runs_size_limit_mb: 50,
    })
    expect((await call(["work", "config", "set", "record_input", "false"], env)).code).toBe(0)
    expect(JSON.parse(readFileSync(file, "utf8")).profiles.work.record_input).toBe(false)
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

  it("**whose deals a CRM copy holds is the owner's**: an agent's run is stopped from setting a CRM account's scope, self, unassigned or stage tasks by mistake", async () => {
    const tool = { ...app, messenger: false }
    const own = settingsFor(tool)
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = {
      CHAT_CONFIG_DIR: join(root, "config"),
      CHAT_STATE_DIR: join(root, "state"),
      MESSAGING_STORE: join(root, "w.db"),
    }
    const call = async (more: NodeJS.ProcessEnv, ...argv: string[]) => {
      const streams = captureStreams()
      const code = await run(
        ["work", "config", ...argv, "--json"],
        { app: tool, commands: () => [configCommand(tool, own)] },
        { streams, tty: false, env: { ...env, ...more } },
      )
      return { code, stderr: streams.stderr.join("\n") }
    }
    const key = "crm.example-crm:portal"
    for (const [name, value] of [
      ["scope", "all"],
      ["self", "7"],
      ["unassigned", "15"],
      ["stage-tasks", '{"C1:WON":{"title":"Send the closing papers","due_days":2}}'],
    ] as const) {
      const refused = await call({ AI_AGENT: "hermes-agent" }, "set", `${key}.${name}`, value)
      expect(refused.code).toBe(5)
      expect(refused.stderr).toContain(`${key}.${name} is the owner's to set`)
      expect((await call({ CLAUDECODE: "1" }, "unset", `${key}.${name}`)).code).toBe(5)
      expect((await call({}, "set", `${key}.${name}`, value)).code).toBe(0)
    }
    expect((await call({ AI_AGENT: "hermes-agent" }, "set", `${key}.links`, "review")).code).toBe(0)
    expect((await call({}, "set", `${key}.stage-tasks`, '{"WON":{"title":"x"}}')).stderr).toContain("due_days")
    const program = new Command("chat").addCommand(configCommand(tool, own))
    expect(changesAuthorityAt(program)(["config", "set"])).toBe(true)
  })

  it("**an agent's shell may tighten a permission but never loosen it** (SEC-116)", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
    const saved = () =>
      JSON.parse(readFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), "utf8")).profiles.work.permissions
    expect((await call(["work", "config", "set", "permissions.messages", "readonly"], env)).code).toBe(0)

    for (const agent of [{ AI_AGENT: "hermes-agent" }, { OPENCLAW_SHELL: "exec" }, { CLAUDECODE: "1" }]) {
      const as = { ...env, ...agent }
      const raised = await call(["work", "config", "set", "permissions.messages", "allow"], as)
      expect(raised.code).toBe(5)
      expect(raised.stderr.join("\n")).toContain("an agent cannot loosen permissions")
      expect((await call(["work", "config", "set", "permissions.messages.send", "ask"], as)).code).toBe(5)
      expect((await call(["work", "config", "unset", "permissions.messages"], as)).code).toBe(5)
      expect((await call(["config", "set", "permissions.messages", "allow", "--defaults"], as)).code).toBe(5)
      expect((await call(["work", "config", "set", "permissions", '{"messages":"allow"}'], as)).code).toBe(5)
    }
    expect(saved()).toEqual({ messages: "readonly" })

    const agent = { ...env, AI_AGENT: "hermes-agent" }
    expect((await call(["work", "config", "set", "permissions.messages", "readonly"], agent)).code).toBe(0)
    expect((await call(["work", "config", "set", "permissions.contacts", "deny"], agent)).code).toBe(0)
    expect((await call(["config", "set", "permissions.contacts", "deny", "--defaults"], agent)).code).toBe(0)
    expect((await call(["work", "config", "set", "permissions.messages", "allow"], env)).code).toBe(0)
    expect(saved()).toMatchObject({ messages: "allow", contacts: "deny" })
  })

  describe("repair", () => {
    const BROKEN = `{
  // the owner's settings
  "profiles": {
    work: {
      'permissions': { "messages": "readonly", "mcp.authority": "deny", },
      "region": "sk-SENTINEL",
      "limit": 7
    }
  },
}`
    const setUp = (text: string, mode = 0o600) => {
      const root = mkdtempSync(join(tmpdir(), "config-"))
      const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
      mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
      const file = join(env.CHAT_CONFIG_DIR, "config.json")
      writeFileSync(file, text)
      chmodSync(file, mode)
      return { env, file, backups: () => readdirSync(env.CHAT_CONFIG_DIR).filter((name) => name.includes(".bak-")) }
    }
    const repairCall = async (argv: string[], env: NodeJS.ProcessEnv, options: Record<string, unknown> = {}) => {
      const streams = captureStreams()
      const code = await run(
        argv,
        { app, commands: () => [configCommand(app, config)] },
        { streams, tty: false, env, ...options },
      )
      const out = `${streams.stdout.join("")}${streams.stderr.join("")}`
      return { code, out, answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]).item : undefined }
    }

    it("**fixes syntax and keeps every value, permissions included**, with a backup in the old mode", async () => {
      const { env, file, backups } = setUp(BROKEN, 0o640)
      const { code, answer, out } = await repairCall(["config", "repair", "--json"], env)

      expect(code, out).toBe(0)
      expect(answer).toMatchObject({ file, found: true, repaired: true, dry_run: false })
      expect(answer.changes.map((fix: { kind: string }) => fix.kind)).toEqual([
        "comment",
        "unquoted_key",
        "single_quotes",
        "trailing_comma",
        "trailing_comma",
      ])
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        profiles: {
          work: { permissions: { messages: "readonly", "mcp.authority": "deny" }, region: "sk-SENTINEL", limit: 7 },
        },
      })
      expect(config.resolveSettings({ profile: "work" }, { env }).permissions).toEqual({
        messages: "readonly",
        "mcp.authority": "deny",
      })
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(backups()).toHaveLength(1)
      expect(answer.backup).toBe(join(env.CHAT_CONFIG_DIR, backups()[0] as string))
      expect(readFileSync(answer.backup, "utf8")).toBe(BROKEN)
      expect(statSync(answer.backup).mode & 0o777).toBe(0o640)
      expect(out).not.toContain("SENTINEL")
    })

    it("**prints lines and kinds, never a value**", async () => {
      const { env } = setUp(BROKEN)
      const { code, out } = await repairCall(["config", "repair"], env)
      expect(code).toBe(0)
      expect(out).toContain("line 2: fixed a comment")
      expect(out).toContain("the old file is kept as")
      expect(out).not.toContain("SENTINEL")
    })

    it("**--dry-run says what it would fix and writes nothing**", async () => {
      const { env, file, backups } = setUp(BROKEN)
      const { code, answer } = await repairCall(["config", "repair", "--dry-run", "--json"], env)
      expect(code).toBe(0)
      expect(answer).toMatchObject({ repaired: false, dry_run: true, backup: null })
      expect(answer.changes.length).toBe(5)
      expect(readFileSync(file, "utf8")).toBe(BROKEN)
      expect(backups()).toEqual([])
    })

    it("**says a valid file or no file needs nothing**, and leaves it as it is", async () => {
      const valid = '{"profiles":{"work":{"limit":3}}}'
      const { env, file, backups } = setUp(valid)
      const { code, answer } = await repairCall(["config", "repair", "--json"], env)
      expect(code).toBe(0)
      expect(answer).toMatchObject({ repaired: false, reason: "nothing to repair", changes: [], backup: null })
      expect(readFileSync(file, "utf8")).toBe(valid)
      expect(backups()).toEqual([])

      const none = { CHAT_CONFIG_DIR: join(mkdtempSync(join(tmpdir(), "config-")), "config") }
      expect((await repairCall(["config", "repair", "--json"], none)).answer).toMatchObject({
        found: false,
        reason: "no settings file",
      })
    })

    it("**gives up and changes nothing** when the damage has two readings", async () => {
      const text = '{"region": "sk-SENTINEL" "limit": 2}'
      const { env, file, backups } = setUp(text)
      const { code, out } = await repairCall(["config", "repair"], env)
      expect(code).toBe(3)
      expect(out).toContain("cannot repair it safely")
      expect(out).toContain("line 1")
      expect(out).not.toContain("SENTINEL")
      expect(readFileSync(file, "utf8")).toBe(text)
      expect(backups()).toEqual([])
    })

    it("**leaves a cut-off file to the owner** when an agent runs it", async () => {
      const text = '{\n  "profiles": {\n    "work": {"limit": 2,\n'
      const { env, file } = setUp(text)
      const { code, out } = await repairCall(["config", "repair"], { ...env, AI_AGENT: "hermes-agent" })
      expect(code).toBe(5)
      expect(out).toContain("the owner repairs it in a terminal")
      expect(readFileSync(file, "utf8")).toBe(text)
      expect((await repairCall(["config", "repair", "--dry-run"], { ...env, AI_AGENT: "hermes-agent" })).code).toBe(0)
      expect((await repairCall(["config", "repair"], env)).code).toBe(0)
    })

    it("**needs mcp.authority over MCP and is refused under the read-only lock**, but may look", async () => {
      const { env, file } = setUp(BROKEN)
      const agent = { result: () => {}, failure: () => {}, authority: false }
      expect((await repairCall(["config", "repair"], env, { agent })).code).toBe(5)
      expect((await repairCall(["config", "repair"], { ...env, CHAT_READ_ONLY: "1" })).code).toBe(5)
      expect((await repairCall(["config", "repair", "--dry-run"], { ...env, CHAT_READ_ONLY: "1" })).code).toBe(0)
      expect(readFileSync(file, "utf8")).toBe(BROKEN)
    })

    it("**answers the desktop's call**: a profile first, --record, listed in commands, errors with file and line", async () => {
      const { env, file } = setUp(BROKEN)
      const streams = captureStreams()
      const program = { app, commands: () => [configCommand(app, config), commandsCommand(app)] }
      expect(await run(["work", "commands", "--json"], program, { streams, tty: false, env })).toBe(0)
      expect(streams.stdout.join("")).toContain('"path":["config","repair"]')
      const done = await repairCall(["work", "config", "repair", "--record", "--json"], env)
      expect(done.code, done.out).toBe(0)
      expect(done.answer).toMatchObject({ repaired: true, file, backup: expect.any(String) })
      expect(done.answer.changes[0]).toEqual({ line: 2, kind: "comment" })

      const broken = setUp('{"a": 1 "b": 2}')
      const failed = captureStreams()
      const code = await run(["work", "config", "repair", "--json"], program, {
        streams: failed,
        tty: false,
        env: broken.env,
      })
      expect(code).toBe(3)
      expect(JSON.parse(failed.stderr.join("")).error).toMatchObject({
        code: "configuration_error",
        reason: "config.unrepairable",
        details: { file: broken.file, line: 1, column: 9 },
      })
    })

    it("**doctor's issue offers the repair only when it would work**", async () => {
      const issueOf = (text: string) =>
        config.resolveSettings({}, { env: setUp(text).env, needsProfile: false, withIssues: true }).configIssues?.[0]
      expect(issueOf(BROKEN)).toMatchObject({ kind: "invalid_json", fix: "chat config repair" })
      expect(issueOf('{"a": 1 "b": 2}')).not.toHaveProperty("fix")
      const own = settingsFor(app, { configRepair: false })
      expect(
        own.resolveSettings({}, { env: setUp(BROKEN).env, needsProfile: false, withIssues: true }).configIssues?.[0],
      ).not.toHaveProperty("fix")
      const refused = await repairCall(["config", "show"], setUp(BROKEN).env)
      expect(refused.out).toContain("`chat config repair` repairs it")
    })
  })
})

describe("every setting in the file (WC-CMD-30)", () => {
  const setUp = (text?: string) => {
    const root = mkdtempSync(join(tmpdir(), "config-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
    const file = join(root, "config", "config.json")
    if (text !== undefined) {
      mkdirSync(join(root, "config"), { recursive: true })
      writeFileSync(file, text)
    }
    return { env, file, read: () => readFileSync(file, "utf8") }
  }
  const declared = config.declaredSettings.map(({ key }) => key.replace("defaults.", ""))

  it("**a first run writes every declared setting at its default**, and a CLI that is not a messenger gets none of a messenger's", async () => {
    const { env, read } = setUp()
    expect((await call(["work", "config", "set", "region", "eu"], env)).code).toBe(0)
    const written = JSON.parse(read())
    expect(Object.keys(written.defaults)).toEqual(expect.arrayContaining(declared))
    expect(written.defaults).toMatchObject({ limit: 20, record: true, search_reranker: "mmarco", sender_colors: false })

    const tool = settingsFor({ ...app, messenger: false })
    const keys = tool.declaredSettings.map(({ key }) => key)
    expect(keys).toContain("defaults.keep_successful_runs_for_days")
    expect(keys).not.toContain("defaults.sender_colors")
  })

  it("**config show does not write the file**, and gives each declared setting its default and what it does", async () => {
    const missing = setUp()
    expect((await call(["config", "show", "--json"], missing.env)).code).toBe(0)
    expect(existsSync(missing.file)).toBe(false)

    const text = '{"defaults":{"limit":7}}'
    const { env, read } = setUp(text)
    const rows = (await call(["config", "show", "--json"], env)).answer.settings
    expect(read()).toBe(text)
    expect(rows.find((row: { setting: string }) => row.setting === "keep_runs_for_days")).toMatchObject({
      value: 30,
      default: 30,
      from: "default",
      description: "days a run is kept",
    })
  })

  it("**config migrate adds what is missing and keeps values, order and unknown keys**, and a second run changes nothing", async () => {
    const { env, read } = setUp(
      JSON.stringify({ profiles: { work: { limit: 5 } }, defaults: { limit: 7, region_old: "eu" }, custom: 1 }),
    )
    const first = await call(["config", "migrate", "--json"], env)
    expect(first.code).toBe(0)
    expect(first.answer.added).toEqual(declared.filter((key) => key !== "limit").map((key) => `defaults.${key}`))
    const migrated = JSON.parse(read())
    expect(Object.keys(migrated)).toEqual(["profiles", "defaults", "custom"])
    expect(Object.keys(migrated.defaults).slice(0, 2)).toEqual(["limit", "region_old"])
    expect(migrated.defaults).toMatchObject({ limit: 7, region_old: "eu", keep_runs_for_days: 30 })
    expect(migrated.profiles).toEqual({ work: { limit: 5 } })

    const before = read()
    const again = await call(["config", "migrate", "--json"], env)
    expect(again.answer.added).toEqual([])
    expect(read()).toBe(before)
  })

  it("**creates defaults when the file has none**, after what is there, and no other section", async () => {
    const { env, read } = setUp('{"profiles":{"work":{"limit":5}}}')
    expect((await call(["config", "migrate", "--json"], env)).answer.added).toHaveLength(declared.length)
    const migrated = JSON.parse(read())
    expect(Object.keys(migrated)).toEqual(["profiles", "defaults"])
    expect(migrated.profiles).toEqual({ work: { limit: 5 } })
    expect(migrated.defaults).toMatchObject({ limit: 20, keep_runs_for_days: 30 })
  })

  it("**a removed default stays removed**, while the other missing ones are added", async () => {
    const { env, read } = setUp('{"defaults":{"limit":7,"record":false}}')
    expect((await call(["config", "unset", "limit", "--defaults"], env)).code).toBe(0)
    const defaults = JSON.parse(read()).defaults
    expect(defaults).not.toHaveProperty("limit")
    expect(defaults).toHaveProperty("keep_runs_for_days", 30)
  })

  it("**an app with a schema of its own gets only the settings that schema takes**", () => {
    const schema = v.strictObject({
      profiles: v.optional(v.record(v.string(), v.object({})), {}),
      defaults: v.optional(v.strictObject({ limit: v.optional(v.number()), record: v.optional(v.boolean()) })),
    })
    const own = settingsFor({ ...app, messenger: false }, { schema })
    expect(own.declaredSettings.map(({ key }) => key)).toEqual(["defaults.limit", "defaults.record"])
  })
})
