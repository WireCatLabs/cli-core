import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as v from "valibot"
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest"
import { levelFor } from "../sends/permissions.js"
import { settingsFor } from "./settings.js"

const { changeSetting, configuredProfiles, resolveSettings } = settingsFor({
  command: "app",
  appName: "app-cli",
  envPrefix: "APP",
  description: "",
  version: "0.0.0",
})

let configDir: string

const withConfig = (contents: string): void => {
  writeFileSync(join(configDir, "config.json"), contents)
}

// Most of these are about the values, not the profile rule: "no profile named" resolves as `default` here.
const settings = (flags = {}, env: NodeJS.ProcessEnv = {}) =>
  resolveSettings(flags, { env, configDir, needsProfile: false })
const strict = (flags = {}, env: NodeJS.ProcessEnv = {}) => resolveSettings(flags, { env, configDir })

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "app-config-"))
})

describe("where a setting came from", () => {
  it("names the layer that decided the profile, so nobody has to re-derive the order", () => {
    expect(settings().sources.profile).toBe("none named")
    expect(settings({}, { APP_PROFILE: "work" }).sources.profile).toBe("APP_PROFILE")
    expect(settings({ profile: "work" }, { APP_PROFILE: "other" }).sources.profile).toBe("first word")
  })

  it("**refuses `default_profile` as any unknown setting**, naming no profile to use instead", () => {
    withConfig(JSON.stringify({ default_profile: "work", profiles: { work: {} } }))
    expect(() => strict({ profile: "work" })).toThrow(
      "setting default_profile is not a setting of app — remove it with `app config unset default_profile`",
    )
    expect(() => strict({ profile: "work" })).not.toThrow(/name the profile|no longer/)
  })

  it("**names where the command budget came from**, which has no file row to fall back on", () => {
    expect(settings().sources.commandTimeoutMs).toBe("default")
    expect(settings({}, { APP_TIMEOUT: "10s" }).sources.commandTimeoutMs).toBe("APP_TIMEOUT")
    expect(settings({ timeout: "1s" }).sources.commandTimeoutMs).toBe("flag")
  })
})

describe("the profiles a file lists", () => {
  it("**is not every profile that works**, and the command that prints it has to say so", () => {
    withConfig(JSON.stringify({ profiles: { default: { limit: 5 }, work: {} } }))
    expect(configuredProfiles({ env: {}, configDir })).toEqual(["default", "work"])

    // `<cli> <name> session start` stores a credential under any name and writes nothing to the file, so
    // this list under-reports by design. `config show` says as much.
    expect(configuredProfiles({ env: {}, configDir })).not.toContain("personal")
  })

  it("is empty, not an error, when there is no file", () => {
    expect(configuredProfiles({ env: {}, configDir })).toEqual([])
  })
})

describe("--timeout", () => {
  it("reads a duration in the three units it accepts", () => {
    expect(settings({ timeout: "500ms" }).commandTimeoutMs).toBe(500)
    expect(settings({ timeout: "30s" }).commandTimeoutMs).toBe(30_000)
    expect(settings({ timeout: "2m" }).commandTimeoutMs).toBe(120_000)
  })

  it("**refuses a bare number**, because the unit is the whole question", () => {
    // `timeoutMs` in the configuration file is milliseconds and every comparable tool means
    // seconds. Either guess is a thirty-fold surprise, so it asks.
    expect(() => settings({ timeout: "30" })).toThrow(/500ms, 30s, 2m, 4h or 1d/)
    expect(() => settings({ timeout: "abc" })).toThrow(/duration with a unit/)
  })

  it("refuses a duration of nothing, which would end the command before it began", () => {
    expect(() => settings({ timeout: "0s" })).toThrow(/more than zero/)
  })

  it("has no bound unless one is given", () => {
    expect(settings().commandTimeoutMs).toBeUndefined()
  })

  it("reads `APP_TIMEOUT`, and the flag outranks it", () => {
    expect(settings({}, { APP_TIMEOUT: "10s" }).commandTimeoutMs).toBe(10_000)
    expect(settings({ timeout: "1s" }, { APP_TIMEOUT: "10s" }).commandTimeoutMs).toBe(1000)
  })

  it("names the variable, not the flag, when the variable is the broken one", () => {
    // Somebody who set this in a shell profile weeks ago needs to know which thing is wrong.
    expect(() => settings({}, { APP_TIMEOUT: "soon" })).toThrow(/APP_TIMEOUT/)
    expect(() => settings({ timeout: "soon" })).toThrow(/--timeout/)
  })

  it("**is not `timeoutMs`**, which stays one request's wait and comes only from the file", () => {
    withConfig(JSON.stringify({ profiles: { default: { timeout_ms: 5000 } } }))
    const resolved = settings({ timeout: "30s" })

    expect(resolved.timeoutMs).toBe(5000)
    expect(resolved.commandTimeoutMs).toBe(30_000)
  })
})

describe("paging", () => {
  it("starts at page one, and turns a page into an offset nobody re-derives", () => {
    expect(settings().page).toBe(1)
    expect(settings({ page: 3 }).page).toBe(3)
    expect(settings().all).toBe(false)
  })

  it("**refuses `--all` with `--page`** rather than letting one of them quietly win", () => {
    expect(() => settings({ all: true, page: 2 })).toThrow(/--all and --page/)
  })

  it("takes `--all` on its own", () => {
    expect(settings({ all: true }).all).toBe(true)
  })

  it("refuses a page number that is not one", () => {
    expect(() => settings({ page: 0 })).toThrow(/--page/)
    expect(() => settings({ page: Number.NaN })).toThrow(/--page/)
  })

  it("**has no configuration field for either**, because a page number in a file is a setting nobody wants twice", () => {
    withConfig(JSON.stringify({ profiles: { default: { page: 2 } } }))
    expect(() => settings()).toThrow()
  })
})

describe("the order a setting is decided in", () => {
  it("prefers the command line to everything else", () => {
    expect(settings({ profile: "fromFlag" }, { APP_PROFILE: "fromEnv" }).profile).toBe("fromFlag")
  })

  it("prefers the environment to the file", () => {
    expect(settings({}, { APP_PROFILE: "fromEnv" }).profile).toBe("fromEnv")
  })

  it("falls back to `default`, which is what an unconfigured machine has", () => {
    expect(settings().profile).toBe("default")
  })

  it("**assumes no profile**: none named is an error that lists the profiles here, even a single one", () => {
    const env = { APP_STATE_DIR: mkdtempSync(join(tmpdir(), "app-state-")) }
    expect(() => strict({}, env)).toThrow("there is none on this computer yet — create one with `app personal setup`")

    withConfig(JSON.stringify({ profiles: { work: {} } }))
    expect(() => strict({}, env)).toThrow("profiles here: work (or set APP_PROFILE)")

    mkdirSync(join(env.APP_STATE_DIR, "accounts"))
    writeFileSync(join(env.APP_STATE_DIR, "accounts", "personal.json"), '{"account":"1"}')
    expect(() => strict({}, env)).toThrow("profiles here: personal, work (or set APP_PROFILE)")
  })

  it("counts the profiles a messenger keeps in its own files, in the error and in `profilesHere`", () => {
    const env = { APP_STATE_DIR: mkdtempSync(join(tmpdir(), "app-state-")) }
    const own = settingsFor(
      { command: "app", appName: "app-cli", envPrefix: "APP", description: "", version: "0.0.0" },
      { profiles: () => ["sales"] },
    )
    expect(() => own.resolveSettings({}, { env, configDir })).toThrow("profiles here: sales (or set APP_PROFILE)")
    expect(own.resolveSettings({}, { env, configDir, needsProfile: false }).profilesHere).toEqual(["sales"])
  })

  it("takes a profile from the first word or APP_PROFILE, and runs a no-account command without", () => {
    const env = { APP_STATE_DIR: mkdtempSync(join(tmpdir(), "app-state-")) }
    withConfig(JSON.stringify({ profiles: { work: {}, personal: {} } }))
    expect(strict({ profile: "work" }, env).profile).toBe("work")
    expect(strict({}, { ...env, APP_PROFILE: "personal" }).profile).toBe("personal")
    expect(settings({}, env)).toMatchObject({ profile: "default", sources: { profile: "none named" } })
  })

  it("reads `APP_PROFILE` as unset when the shell set it to nothing", () => {
    expect(settings({}, { APP_PROFILE: "  " }).profile).toBe("default")
  })

  it("carries the same three steps for a number", () => {
    withConfig(JSON.stringify({ profiles: { default: { limit: 5 } } }))
    expect(settings({ limit: 3 }).limit).toBe(3)
    expect(settings().limit).toBe(5)

    withConfig(JSON.stringify({ profiles: {} }))
    expect(settings().limit).toBe(20)
  })

  it("takes the settings of the profile in play, not of the first one in the file", () => {
    withConfig(JSON.stringify({ profiles: { default: { limit: 1 }, personal: { limit: 99, color: false } } }))
    expect(settings({ profile: "personal" })).toMatchObject({ limit: 99, color: false })
  })

  it("leaves a profile the file says nothing about on the defaults", () => {
    withConfig(JSON.stringify({ profiles: { personal: { limit: 99 } } }))
    expect(settings({ profile: "other" })).toMatchObject({ limit: 20, timeoutMs: undefined, color: undefined })
  })
})

describe("setup's permission answer", () => {
  const answered = (setup: object) => {
    const shared = mkdtempSync(join(tmpdir(), "wirecat-config-"))
    writeFileSync(join(shared, "config.json"), JSON.stringify({ setup }))
    return { WIRECAT_CONFIG_DIR: shared }
  }

  it("**caps every profile**, even a key the profile allows, and names where it came from", () => {
    withConfig(JSON.stringify({ profiles: { agent: { permissions: { "messages.send": "allow" } } } }))
    const { permissions, permissionSources } = resolveSettings(
      { profile: "agent" },
      { env: answered({ permissions: "readonly" }), configDir },
    )
    expect(levelFor(permissions, "messages.send").level).toBe("readonly")
    expect(permissionSources["*"]).toBe("setup answer")
  })

  it('leaves profiles as they are for "allow"; a config file cannot write the ceiling', () => {
    withConfig(JSON.stringify({ profiles: { agent: {} } }))
    const { permissions } = resolveSettings(
      { profile: "agent" },
      { env: answered({ permissions: "allow" }), configDir },
    )
    expect(levelFor(permissions, "messages.send").level).toBe("allow")
    withConfig(JSON.stringify({ profiles: { agent: { permissions: { "*": "allow" } } } }))
    expect(() => resolveSettings({ profile: "agent" }, { env: {}, configDir })).toThrow(/permissions\.\*/)
  })
})

describe("permissions across sections", () => {
  const levelsOf = (file: object, keys: string[], kind?: "bot") => {
    withConfig(JSON.stringify(file))
    const { permissions } = resolveSettings({ profile: "agent" }, { env: {}, configDir, ...(kind ? { kind } : {}) })
    return Object.fromEntries(keys.map((key) => [key, levelFor(permissions, key).level]))
  }

  it("**lets a profile's key hide every key under it in a broader section**", () => {
    const file = {
      defaults: { permissions: { "messages.delete": "allow" } },
      profiles: { agent: { permissions: { messages: "readonly" } } },
    }
    expect(levelsOf(file, ["messages.delete", "messages.send"])).toEqual({
      "messages.delete": "readonly",
      "messages.send": "readonly",
    })
  })

  it("keeps a broader section's key when the profile names one under it", () => {
    const file = {
      defaults: { permissions: { messages: "readonly" } },
      profiles: { agent: { permissions: { "messages.delete": "allow" } } },
    }
    expect(levelsOf(file, ["messages.delete", "messages.send"])).toEqual({
      "messages.delete": "allow",
      "messages.send": "readonly",
    })
  })

  it("**loosens too**: a profile's `messages: allow` hides a shared deny, and deleting falls back to asking", () => {
    const file = {
      defaults: { permissions: { "messages.delete": "deny" } },
      profiles: { agent: { permissions: { messages: "allow" } } },
    }
    expect(levelsOf(file, ["messages.delete"])).toEqual({ "messages.delete": "ask" })
  })

  it("puts a bot profile's own section before the bot defaults", () => {
    const file = {
      bot: {
        defaults: { permissions: { "bot.messages.send": "allow" } },
        profiles: { agent: { permissions: { bot: "readonly" } } },
      },
    }
    expect(levelsOf(file, ["bot.messages.send"], "bot")).toEqual({ "bot.messages.send": "readonly" })
  })
})

describe("a --permission override", () => {
  const resolved = (file: object, permission: string[]) => {
    withConfig(JSON.stringify(file))
    return () => resolveSettings({ profile: "agent", permission }, { env: {}, configDir })
  }
  const readonlyMessages = { profiles: { agent: { permissions: { messages: "readonly" } } } }

  it("**only tightens**: it refuses to lift readonly, deny or a built-in question, naming the key", () => {
    for (const [file, permission, key] of [
      [readonlyMessages, ["messages=allow"], "messages"],
      [readonlyMessages, ["messages.send=ask"], "messages.send"],
      [{ profiles: { agent: { permissions: { "messages.delete": "deny" } } } }, ["messages=allow"], "messages"],
      [
        { profiles: { agent: { permissions: { "messages.delete": "deny" } } } },
        ["messages.delete=readonly"],
        "messages.delete",
      ],
      [{ profiles: { agent: {} } }, ["messages.delete=allow"], "messages.delete"],
    ] as const) {
      expect(resolved(file, [...permission])).toThrow(
        expect.objectContaining({ code: "validation_error", message: expect.stringContaining(key) }),
      )
    }
  })

  it("narrows a profile's level, and may repeat it", () => {
    const { permissions } = resolved(readonlyMessages, ["messages.send=deny", "messages=readonly"])()
    expect(levelFor(permissions, "messages.send").level).toBe("deny")
    expect(levelFor(permissions, "messages.list").level).toBe("readonly")
  })
})

describe("a process locked to one profile", () => {
  it("uses the locked profile when nothing names one, and refuses any other a first word or APP_PROFILE names", () => {
    withConfig(JSON.stringify({ profiles: {} }))
    const lock = { APP_PROFILE_LOCK: "agent" }

    expect(settings({}, lock)).toMatchObject({ profile: "agent", sources: { profile: "APP_PROFILE_LOCK" } })
    expect(settings({ profile: "agent" }, lock).profile).toBe("agent")
    expect(() => settings({ profile: "work" }, lock)).toThrow("locked to profile agent")
    expect(() => settings({}, { ...lock, APP_PROFILE: "work" })).toThrow("locked to profile agent")
  })
})

describe("the configuration file", () => {
  it("**is not required** — an unconfigured machine is not a broken one", () => {
    expect(settings().profile).toBe("default")
  })

  it("**names the field when one is misspelled**, rather than silently using the default", () => {
    withConfig(JSON.stringify({ profiles: { default: { limitt: 5 } } }))
    expect(() => settings()).toThrowError(
      /setting limitt is not a setting of app — remove it with `app default config unset limitt`$/,
    )
    expect(() => settings()).toThrowError(expect.objectContaining({ code: "configuration_error" }))
  })

  it("names a misspelled top-level field too", () => {
    withConfig(JSON.stringify({ defaultProfil: "personal" }))
    expect(() => settings()).toThrowError(/defaultProfil/)
  })

  it("**has nowhere to put a secret**, so a config carrying one is refused", () => {
    withConfig(JSON.stringify({ profiles: { default: { token: "whatever-this-is" } } }))
    expect(() => settings()).toThrowError(/token/)
    expect(() => settings()).not.toThrowError(/whatever-this-is/)
  })

  it("refuses a setting of the wrong type, naming it", () => {
    withConfig(JSON.stringify({ profiles: { default: { limit: "20" } } }))
    expect(() => settings()).toThrowError(/setting limit has to be a whole number, 1 or more — remove it with/)
  })

  it("**names the first problem in plain words**, not the validation library's, and counts the rest", () => {
    withConfig(JSON.stringify({ profiles: { default: { limitt: 5 } } }))
    expect(() => settings()).toThrowError(/config\.json: setting limitt is not a setting of app — remove it with/)

    withConfig(JSON.stringify({ profiles: { default: { limit: 0, color: "yes" } } }))
    expect(() => settings()).toThrowError(
      /: setting limit has to be a whole number, 1 or more — .*\(and 1 more problem/,
    )

    withConfig(JSON.stringify({ profiles: { default: { limit: 2.5, color: 1 } }, defaultProfil: "x", other: 1 }))
    expect(() => settings()).toThrowError(/\(and 3 more problems — `doctor` lists them all\)$/)
    expect(() => settings()).not.toThrowError(/Expected|Invalid|2\.5/)
  })

  it("**never prints a setting's value**, only its key and what it has to be", () => {
    withConfig(JSON.stringify({ profiles: { default: { color: "secret-looking-value" } } }))
    expect(() => settings()).toThrowError(/: setting color has to be true or false — remove it with/)
    expect(() => settings()).not.toThrowError(/secret-looking-value/)
    withConfig(JSON.stringify({ profiles: { default: { transcribe_with: "secret-looking-value" } } }))
    expect(() => settings()).toThrowError(/setting transcribe_with has to be auto, messenger or local/)
    expect(() => settings()).not.toThrowError(/secret-looking-value/)
  })

  it("**points no camelCase key at a snake_case one**: it is just an unknown setting", () => {
    withConfig(JSON.stringify({ profiles: { work: { timeoutMs: 5 } } }))
    expect(() => settings()).toThrowError(/setting timeoutMs is not a setting of app/)
    expect(() => settings()).not.toThrowError(/rename|timeout_ms/)
  })
})

describe("changing a setting", () => {
  const path = () => join(configDir, "config.json")
  const file = () => JSON.parse(readFileSync(path(), "utf8"))

  it("writes a profile's setting as the type the file holds, and removes it again", () => {
    expect(changeSetting(path(), { profile: "work", setting: "limit", value: "50" })).toBe(50)
    changeSetting(path(), { profile: "work", setting: "record", value: "true" })
    expect(file()).toEqual({ profiles: { work: { limit: 50, record: true } } })

    changeSetting(path(), { profile: "work", setting: "limit", value: undefined })
    changeSetting(path(), { profile: "work", setting: "record", value: undefined })
    expect(file()).toEqual({})
  })

  it("**writes one permission key at a time**, and refuses a level that is not one", () => {
    changeSetting(path(), { profile: "work", setting: "permissions.messages.delete", value: "allow" })
    changeSetting(path(), { profile: "work", setting: "permissions.contacts", value: "readonly" })
    expect(file()).toEqual({
      profiles: { work: { permissions: { "messages.delete": "allow", contacts: "readonly" } } },
    })
    expect(() => changeSetting(path(), { profile: "work", setting: "permissions.contacts", value: "maybe" })).toThrow(
      /deny, readonly, ask, allow/,
    )
    expect(() => changeSetting(path(), { profile: "work", setting: "permissions.mesages", value: "deny" })).toThrow(
      /permissions\.mesages names no command/,
    )
  })

  it("writes to `defaults` when no profile is named", () => {
    changeSetting(path(), { profile: undefined, setting: "keep_runs_for_days", value: "7" })
    expect(file().defaults).toEqual({ keep_runs_for_days: 7 })
  })

  it("**refuses a value the reader would refuse, and leaves the file as it was**", () => {
    withConfig(JSON.stringify({ profiles: { work: { limit: 5 } } }))

    expect(() => changeSetting(path(), { profile: "work", setting: "limit", value: "0" })).toThrow(/limit/)
    expect(() => changeSetting(path(), { profile: "work", setting: "color", value: "blue" })).toThrow(/color/)
    expect(() => changeSetting(path(), { profile: "work", setting: "limitt", value: "5" })).toThrow(/no setting/)
    expect(file()).toEqual({ profiles: { work: { limit: 5 } } })
  })
})

describe("a bot's settings", () => {
  const bot = (flags = {}) => resolveSettings(flags, { env: {}, configDir, kind: "bot", needsProfile: false })

  it("**takes the most specific entry**: the bot's profile, the profile, every bot, everyone", () => {
    withConfig(
      JSON.stringify({
        defaults: { limit: 10 },
        profiles: { sales: { limit: 20, record: true } },
        bot: { defaults: { limit: 30, keep_runs_for_days: 3 }, profiles: { sales: { limit: 40 } } },
      }),
    )
    const sales = bot({ profile: "sales" })
    expect(sales.limit).toBe(40)
    expect(sales.sources.limit).toBe("config file: bot.profiles.sales")
    expect(sales.record).toBe(true)
    expect(sales.keepRunsForDays).toBe(3)
    expect(settings({ profile: "sales" }).limit).toBe(20)
    expect(bot({ profile: "sales", limit: 5 }).limit).toBe(5)
  })

  it("**has no hourly limit** unless the bot section gives it one", () => {
    withConfig(
      JSON.stringify({ defaults: { sends_per_hour: 10 }, bot: { profiles: { sales: { sends_per_hour: 200 } } } }),
    )
    expect(bot({ profile: "news" }).sendsPerHour).toBe(Number.POSITIVE_INFINITY)
    expect(bot({ profile: "sales" }).sendsPerHour).toBe(200)
    expect(settings({ profile: "news" }).sendsPerHour).toBe(10)
  })

  it("**reads other bots only when the bot section allows it**", () => {
    withConfig(JSON.stringify({ bot: { profiles: { shop: { read_other_bots: ["news"] } } } }))
    expect(bot({ profile: "shop" }).readOtherBots).toEqual(["news"])
    expect(bot({ profile: "news" }).readOtherBots).toBe(false)
    expect(settings({ profile: "shop" }).readOtherBots).toBe(false)
    expect(() =>
      changeSetting(join(configDir, "config.json"), { profile: "shop", setting: "read_other_bots", value: "true" }),
    ).toThrow(/--bot/)
  })

  it("**writes into the bot section** and tidies it when emptied", () => {
    const path = join(configDir, "config.json")
    changeSetting(path, { profile: "sales", setting: "sends_per_hour", value: "200", kind: "bot" })
    changeSetting(path, { profile: undefined, setting: "read_other_bots", value: "true", kind: "bot" })
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      profiles: {},
      bot: { defaults: { read_other_bots: true }, profiles: { sales: { sends_per_hour: 200 } } },
    })
    expect(configuredProfiles({ env: {}, configDir })).toEqual(["sales"])

    changeSetting(path, { profile: "sales", setting: "sends_per_hour", value: undefined, kind: "bot" })
    changeSetting(path, { profile: undefined, setting: "read_other_bots", value: undefined, kind: "bot" })
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ profiles: {} })
  })
})

const NAMED = { APP_PROFILE: "default" }

describe("settings extensions", () => {
  const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "", version: "0.0.0" }
  const adapted = settingsFor(app, {
    profile: { autoStart: v.optional(v.boolean()) },
    defaults: { audioModel: v.optional(v.string()) },
    sourcePaths: true,
    resolve: ({ fromLayers, settings }) => {
      const autoStart = fromLayers("autoStart", true)
      return {
        values: { autoStart: autoStart.value, audioModel: settings.shared.audioModel ?? "small" },
        sources: { autoStart: autoStart.from },
      }
    },
  })

  it("resolves adapter fields from every kind/profile layer and keeps their provenance", () => {
    withConfig(
      JSON.stringify({
        defaults: { autoStart: false, audioModel: "large" },
        profiles: { work: { autoStart: true } },
        personal: { defaults: { autoStart: false }, profiles: { work: { autoStart: false } } },
      }),
    )
    const result = adapted.resolveSettings({ profile: "work" }, { env: {}, configDir })
    expect(result).toMatchObject({
      autoStart: false,
      audioModel: "large",
      sources: {
        autoStart: "config file: personal.profiles.work",
        profile: "first word",
      },
    })
    expect(adapted.resolveSettings({ profile: "work" }, { env: {}, configDir, kind: "bot" }).autoStart).toBe(true)
    expect(adapted.resolveSettings({ profile: "work" }, { env: {}, configDir, kind: "bot" }).sources.autoStart).toBe(
      "config file: profiles.work",
    )
    withConfig(JSON.stringify({ defaults: { autoStart: false } }))
    expect(adapted.resolveSettings({}, { env: NAMED, configDir })).toMatchObject({
      autoStart: false,
      sources: { autoStart: "config file: defaults" },
    })
    withConfig("{}")
    expect(adapted.resolveSettings({}, { env: NAMED, configDir })).toMatchObject({
      autoStart: true,
      sources: { autoStart: "default" },
    })
  })

  it("preserves detailed shared/AI and permission sources without changing default callers", () => {
    withConfig(
      JSON.stringify({
        defaults: { limit: 7, update_check: false, skill_hint: false },
        profiles: { work: { permissions: { messages: "readonly" }, embedding_model: "test-model" } },
      }),
    )
    const result = adapted.resolveSettings({ profile: "work" }, { env: NAMED, configDir })
    expect(result.sources).toMatchObject({
      limit: "config file: defaults",
      updateCheck: "config file: defaults",
      skillHint: "config file: defaults",
      embeddingModel: "config file: profiles.work",
    })
    expect(Object.values(result.permissionSources)).toContain("config file: profiles.work")
    expect(settings({ profile: "work" }).sources.limit).toBe("config defaults")
    expect(Object.values(settings({ profile: "work" }).permissionSources)).toContain("config file")
  })

  it("uses an adapter schema for reads and accepts an adapter duration parser", () => {
    const resolve = settingsFor(app, {
      schema: v.object({
        profiles: v.optional(v.record(v.string(), v.object({})), {}),
        marker: v.optional(v.literal("valid")),
      }),
      parseDuration: (value, source) => {
        expect(source).toBe("APP_TIMEOUT")
        return value === "one-tick" ? 1 : 2
      },
    }).resolveSettings
    withConfig('{"marker":"valid"}')
    expect(resolve({}, { env: { ...NAMED, APP_TIMEOUT: "one-tick" }, configDir }).commandTimeoutMs).toBe(1)
    withConfig('{"marker":"invalid"}')
    expect(() => resolve({}, { env: NAMED, configDir })).toThrowError(
      expect.objectContaining({ code: "configuration_error" }),
    )
  })
  it("uses the compatibility schema for config writes as well as reads", () => {
    const adapter = settingsFor(app, {
      profile: { autoStart: v.optional(v.boolean()) },
      schema: v.strictObject({
        profiles: v.optional(v.record(v.string(), v.object({})), {}),
        defaults: v.optional(v.strictObject({ autoStart: v.optional(v.literal(true, "autoStart must be true")) })),
      }),
    })
    withConfig("{}")
    expect(() =>
      adapter.changeSetting(join(configDir, "config.json"), {
        profile: undefined,
        setting: "autoStart",
        value: "false",
      }),
    ).toThrow("autoStart must be true")
    expect(
      adapter.changeSetting(join(configDir, "config.json"), {
        profile: undefined,
        setting: "autoStart",
        value: "true",
      }),
    ).toBe(true)
    expect(adapter.resolveSettings({}, { env: NAMED, configDir }).shared.autoStart).toBe(true)
  })
})

it("preserves public schema entry types when a provider composes permission settings", () => {
  const { schema } = settingsFor({
    command: "app",
    appName: "app-cli",
    envPrefix: "APP",
    description: "",
    version: "0.0.0",
  })
  expectTypeOf<keyof typeof schema.entries>().toEqualTypeOf<"defaults" | "profiles" | "personal" | "bot">()
  const provider = v.strictObject({
    permissions: schema.entries.defaults.wrapped.entries.permissions,
    custom: v.optional(v.boolean()),
  })
  type Keys = keyof v.InferOutput<typeof provider>
  expectTypeOf<Keys>().toEqualTypeOf<"permissions" | "custom">()
  const keys: Keys[] = ["permissions", "custom"]
  const names: string[] = keys
  expect(names).toEqual(["permissions", "custom"])
})

describe("a setting no schema knows", () => {
  it.each(["catch_up_marks_read", "default_profile"])("refuses %s like any other, pointing nowhere else", (key) => {
    withConfig(JSON.stringify({ profiles: { personal: { [key]: true } } }))
    expect(() => settings()).toThrowError(
      expect.objectContaining({
        code: "configuration_error",
        message: expect.stringContaining(
          `setting ${key} is not a setting of app — remove it with \`app personal config unset ${key}\``,
        ),
      }),
    )
    expect(() => settings()).not.toThrowError(/mark-read|name the profile/)
  })
})
