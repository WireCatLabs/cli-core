import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams, configFilePath, saveConfigFile } from "@wirecat/cli-base"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import {
  assertStatsPermissionsCurrent,
  DEFAULT_PERMISSIONS,
  fromOldSettings,
  keyForCommand,
  levelFor,
  PERMISSIONS,
  RESOURCES,
  readKeysForCommand,
} from "../sends/permissions.js"
import { configCommand } from "./config-command.js"
import { migratePermissionConfig } from "./permission-migration.js"
import { run } from "./program.js"
import { type Config, settingsFor } from "./settings.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "test", version: "0" }
const configuration = settingsFor(app, {
  profile: { mcpTools: v.optional(v.array(v.string())), region: v.optional(v.string()) },
})

describe("statistics permission relocation", () => {
  it("moves scoped permissions without changing their levels or the input", () => {
    const input: Config = {
      profiles: { work: { permissions: { "messages.stats": "deny", "chats.stats": "readonly" } } },
    }
    const result = migratePermissionConfig(input)
    expect(result.changed).toBe(true)
    expect(result.config.profiles.work?.permissions).toEqual({
      "stats.messages.show": "deny",
      "stats.chats.show": "readonly",
    })
    expect(input.profiles.work?.permissions).toHaveProperty("messages.stats", "deny")
    expect(migratePermissionConfig(result.config).changed).toBe(false)
  })

  it("refuses a conflict instead of replacing a stronger restriction", () => {
    const input: Config = {
      profiles: { work: { permissions: { "messages.stats": "deny", "stats.messages.show": "allow" } } },
    }
    expect(() => migratePermissionConfig(input)).toThrow("conflicting")
  })
})
describe("search permission relocation", () => {
  it("moves every old search key under search, bot keys too, keeping each level", () => {
    const input: Config = {
      profiles: {
        work: {
          permissions: {
            "messages.search": "deny",
            "conversations.search": "readonly",
            "topics.search": "deny",
            "bot.messages.search": "deny",
          },
        },
      },
    }
    const result = migratePermissionConfig(input)
    expect(result.config.profiles.work?.permissions).toEqual({
      "search.messages": "deny",
      "search.conversations": "readonly",
      "search.topics": "deny",
      "bot.search.messages": "deny",
    })
    expect(migratePermissionConfig(result.config).changed).toBe(false)
  })

  it("refuses a search until the old keys are migrated, and lets messages: deny reach every leaf that reads messages", () => {
    expect(() => assertStatsPermissionsCurrent(["search", "messages"], { "messages.search": "deny" })).toThrow(
      "config migrate",
    )
    expect(() =>
      assertStatsPermissionsCurrent(["bot", "search", "messages"], { "bot.messages.search": "deny" }),
    ).toThrow("config migrate")
    expect(() => assertStatsPermissionsCurrent(["messages", "list"], { "messages.search": "deny" })).not.toThrow()
    for (const leaf of ["all", "messages", "mail", "conversations"])
      expect(readKeysForCommand(["search", leaf])).toContain("messages")
    expect(readKeysForCommand(["search", "notes"])).toEqual(["search.notes"])
    expect(readKeysForCommand(["search", "topics"])).toEqual(["search.topics", "topics"])
    expect(keyForCommand(["search", "all"])).toBe("search.all")
  })
})
const fresh = () => {
  const configDirectory = join(mkdtempSync(join(tmpdir(), "permission-migrate-")), "config")
  return { path: configFilePath(configDirectory), env: { CHAT_CONFIG_DIR: configDirectory } }
}
const call = async (args: string[], env: NodeJS.ProcessEnv) => {
  const streams = captureStreams()
  const code = await run(
    args,
    { app, commands: () => [configCommand(app, configuration)] },
    { env, tty: false, streams },
  )
  return { code, data: JSON.parse(streams.stdout.join("\n") || "null"), error: streams.stderr.join("\n") }
}
const names = ["default", "new-user", "alice", "bob", "constructor"]
const keys = [
  ...new Set([
    ...RESOURCES.filter((key) => key !== "bot"),
    ...Object.keys(DEFAULT_PERMISSIONS).filter((key) => !key.startsWith("bot.")),
    ...Object.keys(fromOldSettings(false, [...PERMISSIONS])),
    "messages.list",
    "messages.send",
    "messages.edit",
    "chats.members.remove",
    "contacts.show",
  ]),
]
const snapshot = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    ["personal", "bot"].flatMap((kind) =>
      names.map((profile) => {
        const settings = configuration.resolveSettings({ profile }, { env, kind: kind as "personal" | "bot" })
        const relevant = kind === "bot" ? ["bot", ...keys.map((key) => `bot.${key}`), "bot.commands"] : keys
        return [`${kind}.${profile}`, relevant.map((key) => [key, levelFor(settings.permissions, key).level])]
      }),
    ),
  )

describe("permission configuration migration", () => {
  it.each(PERMISSIONS)("preserves every old %s allow word in both kinds and every layer", (word) => {
    const { path, env } = fresh()
    const input: Config = {
      defaultProfile: "alice",
      defaults: { allow: [word], region: "shared", mcpTools: ["groups"] },
      profiles: { alice: { allow: [] }, bob: { readOnly: false, allow: ["send"] } },
      personal: { defaults: { readOnly: false }, profiles: { bob: { allow: [word], region: "personal" } } },
      bot: { defaults: { allow: ["profile"] }, profiles: { alice: { allow: [word], readOnly: false } } },
    }
    saveConfigFile(path, input)
    const before = snapshot(env)
    const source = JSON.stringify(input)
    const result = migratePermissionConfig(input)
    expect(JSON.stringify(input)).toBe(source)
    saveConfigFile(path, result.config)
    expect(snapshot(env)).toEqual(before)
    expect(result.changed).toBe(true)
    expect(result.config.defaults?.region).toBe("shared")
    expect(result.config.personal?.profiles?.bob?.region).toBe("personal")
    expect(JSON.stringify(result.config)).not.toMatch(/"(readOnly|allow|mcpTools)":/)
    expect(migratePermissionConfig(result.config)).toMatchObject({ changed: false, changes: [] })
  })

  it("preserves readOnly resets, critical ask defaults and existing canonical overrides", () => {
    const { path, env } = fresh()
    const input: Config = {
      defaults: { readOnly: true, permissions: { "messages.send": "ask", "bot.commands": "allow" } },
      profiles: {
        alice: { readOnly: false },
        bob: { allow: ["delete"], readOnly: false },
        constructor: { readOnly: false, allow: [] },
      },
      personal: { profiles: { alice: { permissions: { "messages.send": "deny", "chats.join": "allow" } } } },
      bot: { defaults: { readOnly: false }, profiles: { bob: { readOnly: true } } },
    }
    saveConfigFile(path, input)
    const before = snapshot(env)
    const migrated = migratePermissionConfig(input)
    saveConfigFile(path, migrated.config)
    expect(snapshot(env)).toEqual(before)
    expect(migrated.config.personal?.profiles?.alice?.permissions).toMatchObject({
      "messages.send": "deny",
      "chats.join": "allow",
    })
    expect(Reflect.get(Object.prototype, "permissions")).toBeUndefined()
    expect(Reflect.get(Object, "permissions")).toBeUndefined()
  })

  it("keeps a profile's old `readOnly` nearer than a shared section's `permissions`", () => {
    const input: Config = {
      defaults: { permissions: { "messages.delete": "allow", "messages.send": "allow" } },
      profiles: { alice: { readOnly: true } },
    }
    const { path, env } = fresh()
    saveConfigFile(path, input)
    const before = snapshot(env)
    saveConfigFile(path, migratePermissionConfig(input).config)
    expect(snapshot(env)).toEqual(before)
    const alice = configuration.resolveSettings({ profile: "alice" }, { env })
    expect(levelFor(alice.permissions, "messages.delete").level).toBe("readonly")
  })

  it("does not let a replacement allow-list inherit a parent's permitted write", () => {
    const input: Config = { defaults: { allow: ["send"] }, profiles: { alice: { allow: ["reaction"] } } }
    const { path, env } = fresh()
    saveConfigFile(path, input)
    const before = snapshot(env)
    const migrated = migratePermissionConfig(input)
    saveConfigFile(path, migrated.config)
    expect(snapshot(env)).toEqual(before)
    const levels = configuration.resolveSettings({ profile: "alice" }, { env }).permissions
    expect(levelFor(levels, "messages.send").level).toBe("readonly")
    expect(levelFor(levels, "reactions").level).toBe("allow")
  })

  it("previews, applies once and then leaves the same file untouched", async () => {
    const { path, env } = fresh()
    saveConfigFile(path, { profiles: {}, defaults: { allow: ["send"], mcpTools: ["polls"], region: "eu" } })
    const original = readFileSync(path, "utf8")
    const dry = await call(["config", "migrate", "--dry-run", "--json"], env)
    expect(dry.code, dry.error).toBe(0)
    expect(dry.data).toMatchObject({ configFile: path, changed: true, dryRun: true, changes: expect.any(Array) })
    expect(readFileSync(path, "utf8")).toBe(original)
    const applied = await call(["config", "migrate", "--json"], env)
    expect(applied.code, applied.error).toBe(0)
    expect(applied.data).toMatchObject({ changed: true, dryRun: false })
    const written = readFileSync(path, "utf8")
    expect(JSON.parse(written).defaults.region).toBe("eu")
    expect((await call(["config", "migrate", "--json"], env)).data).toMatchObject({ changed: false, changes: [] })
    expect(readFileSync(path, "utf8")).toBe(written)
  })

  it("initializes a missing file and refuses locked writes while allowing a preview", async () => {
    const { path, env } = fresh()
    const empty = await call(["config", "migrate", "--json"], env)
    expect(empty.code, empty.error).toBe(0)
    expect(empty.data.changed).toBe(false)
    expect(existsSync(path)).toBe(true)
    saveConfigFile(path, { profiles: {}, defaults: { readOnly: true } })
    const original = readFileSync(path, "utf8")
    const locked = { ...env, CHAT_PROFILE_LOCK: "alice" }
    const refused = await call(["config", "migrate", "--json"], locked)
    expect(refused.code).toBe(5)
    expect(readFileSync(path, "utf8")).toBe(original)
    expect((await call(["config", "migrate", "--dry-run", "--json"], locked)).code).toBe(0)
  })

  it.each([{ readOnly: "true" }, { allow: ["typo"] }, { mcpTools: "groups" }, { permissions: { messages: "typo" } }])(
    "refuses malformed legacy or canonical settings without changing the source",
    (defaults) => {
      const input: Config = { profiles: {}, defaults }
      const original = JSON.stringify(input)
      expect(() => migratePermissionConfig(input)).toThrow()
      expect(JSON.stringify(input)).toBe(original)
    },
  )
  it("refuses an invalid input file and an invalid transformed file without writing either", async () => {
    const { path, env } = fresh()
    saveConfigFile(path, { profiles: {}, defaults: { allow: ["typo"] } })
    const original = readFileSync(path, "utf8")
    expect((await call(["config", "migrate", "--json"], env)).code).not.toBe(0)
    expect(readFileSync(path, "utf8")).toBe(original)
    const restricted = settingsFor(app, { profile: { permissions: v.optional(v.never()) } })
    saveConfigFile(path, { profiles: {}, defaults: { readOnly: true } })
    const validLegacy = readFileSync(path, "utf8")
    const streams = captureStreams()
    const code = await run(
      ["config", "migrate", "--json"],
      { app, commands: () => [configCommand(app, restricted)] },
      { env, tty: false, streams },
    )
    expect(code).not.toBe(0)
    expect(streams.stdout).toEqual([])
    expect(readFileSync(path, "utf8")).toBe(validLegacy)
  })
  it.each(["readOnly", "allow", "mcpTools"])(
    "refuses legacy %s edits after migration, including a false-only legacy file",
    async (setting) => {
      const { path, env } = fresh()
      saveConfigFile(path, { profiles: {}, defaults: { readOnly: false } })
      expect((await call(["config", "migrate", "--json"], env)).code).toBe(0)
      const migrated = readFileSync(path, "utf8")
      const edit = await call(["config", "set", setting, setting === "readOnly" ? "true" : "send", "--json"], env)
      expect(edit.code).toBe(2)
      expect(edit.error).toContain("legacy setting")
      expect((await call(["config", "unset", setting, "--json"], env)).code).toBe(2)
      expect(readFileSync(path, "utf8")).toBe(migrated)
    },
  )
})

it("moves descendant statistics permissions and bot-prefixed keys without broadening their scope", () => {
  const before: Config = {
    profiles: {},
    defaults: {
      permissions: {
        "messages.stats.sync-first": "deny",
        "bot.chats.stats": "readonly",
        messages: "readonly",
      },
    },
  }
  const after = migratePermissionConfig(before)
  expect(after.config.defaults?.permissions).toEqual({
    "stats.messages.show.sync-first": "deny",
    "bot.stats.chats.show": "readonly",
    messages: "readonly",
  })
  expect(before.defaults?.permissions).toHaveProperty("messages.stats.sync-first", "deny")
  expect(migratePermissionConfig(after.config).changed).toBe(false)
})
