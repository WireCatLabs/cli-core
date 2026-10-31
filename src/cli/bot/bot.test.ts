import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base"
import { beforeEach, describe, expect, it } from "vitest"
import type { AppIdentity } from "../../ports/app.js"
import { botFiles, ChatRegistry, registryProfiles } from "./registry.js"
import { BotTokenStore } from "./token.js"

const app = (command: string, envPrefix: string): AppIdentity => ({
  command,
  appName: `${command}-cli`,
  envPrefix,
  description: "",
  version: "0.0.0",
})
const MAX = app("max", "MAX")
const TG = app("tg", "TG")

let home: string
/**
 * The token tests name no directory variable, because one would make the keyring service the
 * isolated one, and pass `configDir` instead; nothing here may fall back to the owner's home.
 */
const env: NodeJS.ProcessEnv = {}
let configDir: string
let files: NodeJS.ProcessEnv

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bot-"))
  configDir = join(home, "config")
  files = { MAX_STATE_DIR: join(home, "max"), TG_STATE_DIR: join(home, "tg") }
})

describe("a bot's token", () => {
  it("**reads the keyring entries both CLIs already have**: max-cli and tg-cli, account bot:<name>", () => {
    const keyring = memoryKeyring({ "max-cli:bot:sales": "max-token", "tg-cli:bot:testbot": "tg-token" })

    expect(new BotTokenStore({ app: MAX, profile: "sales", env, configDir, keyring }).read()).toEqual({
      token: "max-token",
      source: "keyring",
    })
    expect(new BotTokenStore({ app: TG, profile: "testbot", env, configDir, keyring }).read()?.token).toBe("tg-token")
  })

  it("**takes <PREFIX>_BOT_TOKEN first**, as CI sets it", () => {
    const keyring = memoryKeyring({ "max-cli:bot:sales": "kept" })
    const store = new BotTokenStore({
      app: MAX,
      profile: "sales",
      env: { MAX_BOT_TOKEN: "from-ci" },
      configDir,
      keyring,
    })

    expect(store.read()).toEqual({ token: "from-ci", source: "environment" })
  })

  it("keeps a bot's token apart from the personal session and from other bots", () => {
    const keyring = memoryKeyring()
    new BotTokenStore({ app: TG, profile: "sales", env, configDir, keyring }).write("one")

    expect([...keyring.entries.keys()]).toEqual(["tg-cli:bot:sales"])
    expect(new BotTokenStore({ app: TG, profile: "support", env, configDir, keyring }).read()).toBeUndefined()
  })

  it("moves a token and a named secret the keyring once refused back to it when the owner sets them again", () => {
    const memory = memoryKeyring()
    let locked = true
    const keyring = {
      get: (service: string, account: string) => {
        if (locked) throw new Error("locked")
        return memory.get(service, account)
      },
      set: (service: string, account: string, secret: string) => {
        if (locked) throw new Error("locked")
        memory.set(service, account, secret)
      },
      delete: (service: string, account: string) => memory.delete(service, account),
    }
    const store = () => new BotTokenStore({ app: TG, profile: "sales", env, configDir, keyring })

    expect(store().write("one")).toBe("file")
    expect(store().writeSecret("app-secret", "first")).toBe("file")
    locked = false

    expect(store().write("two")).toBe("keyring")
    expect(store().writeSecret("app-secret", "second")).toBe("keyring")
    expect(store().read()).toEqual({ token: "two", source: "keyring" })
    expect(store().readSecret("app-secret")).toEqual({ secret: "second", source: "keyring" })
    const file = join(configDir, "credentials.json")
    expect(existsSync(file) ? readFileSync(file, "utf8") : "").not.toContain("bot:sales")
  })

  it("stores returned credentials only in the keyring and never falls back or exposes a keyring error", () => {
    const keyring = memoryKeyring()
    const store = new BotTokenStore({
      app: TG,
      profile: "managed",
      env: { TG_BOT_TOKEN: "override" },
      configDir,
      keyring,
    })
    store.writeKeyring("returned")
    expect(store.readKeyring()).toBe("returned")
    expect(store.read()?.token).toBe("override")
    const broken = new BotTokenStore({
      app: TG,
      profile: "managed",
      env,
      configDir,
      keyring: {
        get: () => {
          throw new Error("private-value")
        },
        set: () => {
          throw new Error("private-value")
        },
        delete: () => false,
      },
    })
    expect(() => broken.readKeyring()).toThrow("the OS keyring is unavailable")
    expect(() => broken.writeKeyring("returned")).toThrow("could not be stored in the OS keyring")
    expect(existsSync(join(configDir, "credentials.json"))).toBe(false)
  })
})

describe("a bot's files", () => {
  it("**are where max-cli has always kept them**, so a recipient list is never lost on the way", () => {
    const bots = join(home, "max", "bots")

    expect(botFiles(MAX, "sales", files)).toEqual({
      registry: join(bots, "sales.json"),
      recipients: join(bots, "recipients", "sales.json"),
      journal: join(bots, "sends", "sales.jsonl"),
      updates: join(bots, "updates", "sales.json"),
      presses: join(bots, "presses", "sales.json"),
      checks: join(bots, "checks", "sales.json"),
    })
  })

  it("remembers the chats a bot has seen, newer facts winning, and names every bot that kept one", () => {
    const registry = new ChatRegistry(TG, "testbot", files)
    registry.observe([{ id: "-100", title: "Team", kind: "group" }], new Date("2026-10-01T10:00:00Z"))
    registry.observe([{ id: "-100" }], new Date("2026-10-01T11:00:00Z"))
    registry.rememberBot("42")

    expect(registry.list()).toMatchObject([
      { id: "-100", title: "Team", firstSeenAt: "2026-10-01T10:00:00.000Z", lastSeenAt: "2026-10-01T11:00:00.000Z" },
    ])
    expect(registry.botId()).toBe("42")
    new ChatRegistry(TG, "news", files).touch()
    expect(registryProfiles(TG, files).sort()).toEqual(["news", "testbot"])
    expect(registryProfiles(MAX, files)).toEqual([])
  })
})
