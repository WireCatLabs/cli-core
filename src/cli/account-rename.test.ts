import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams, type KeyringStore } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { openStore } from "../store/store.js"
import { messenger } from "../testing/shared-program.js"
import { type AccountRenaming, accountRenameCommand } from "./account-rename.js"
import { accountCommand } from "./messenger/account-command.js"
import { accountFileFor, rememberAccount } from "./messenger/accounts.js"
import { run } from "./program.js"
import { settingsFor } from "./settings.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "synthetic", version: "1.0.0" }
const SERVICE = "chat-cli"

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), "account-rename-"))
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "xdg"),
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_CACHE_DIR: join(root, "cache"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  mkdirSync(join(root, "config"), { recursive: true })
  writeFileSync(
    join(root, "config", "config.json"),
    JSON.stringify({ profiles: { personal: { record: false }, work: { record: true } } }),
  )
  rememberAccount(app, "personal", "500", env)
  rememberAccount(app, "work", "600", env)
  const store = await openStore({ env })
  await store.accounts.saveAccount({ provider: "telegram", account: "500" }, { name: "personal" })
  await store.accounts.saveProfile("chat", "personal", { provider: "telegram", account: "500" })
  await store.accounts.saveAccountGroup("family", ["chat:personal", "max:home"])
  await store.close()
  mkdirSync(join(root, "state", "sessions"), { recursive: true })
  mkdirSync(join(root, "state", "media", "personal"), { recursive: true })
  writeFileSync(join(root, "state", "sessions", "personal.session"), "synthetic")
  writeFileSync(join(root, "state", "media", "personal", "photo.jpg"), "synthetic")
  const keyring = memoryKeyring({
    [`${SERVICE}:token:personal`]: "synthetic-token",
    [`${SERVICE}:app-keys:personal`]: "synthetic-keys",
    [`${SERVICE}:app-keys:work`]: "synthetic-keys",
  })
  return { root, env, keyring }
}

type Setup = Awaited<ReturnType<typeof setup>>

const renamingOf = ({ root }: Setup): AccountRenaming => ({
  signOut: async () => ({ revoked: null, removed: [] }),
  signIn: (profile) => ({ files: [join(root, "state", "sessions", `${profile}.session`)] }),
  secrets: (profile) => [
    { credentials: { service: SERVICE, configDir: join(root, "config") }, accounts: [`app-keys:${profile}`] },
  ],
  dataFiles: (profile) => [join(root, "state", "media", profile)],
})

const call = async (
  argv: string[],
  { env, keyring }: { env: NodeJS.ProcessEnv; keyring: KeyringStore },
  renaming: AccountRenaming,
) => {
  const streams = captureStreams()
  const code = await run(
    argv,
    {
      app,
      commands: () => [
        new Command("account").addCommand(
          accountRenameCommand(app, renaming, { resolveSettings: settingsFor(app).resolveSettings }),
        ),
      ],
    },
    { streams, tty: false, env, keyring },
  )
  const out = streams.stdout.join("")
  const err = streams.stderr.join("")
  return {
    code,
    item: out ? JSON.parse(out).item : undefined,
    error: err.startsWith("{") ? JSON.parse(err).error : undefined,
  }
}

const config = (root: string) => JSON.parse(readFileSync(join(root, "config", "config.json"), "utf8"))

describe("account rename", () => {
  it("lists what it would move and changes nothing on a dry run", async () => {
    const given = await setup()
    const { item } = await call(
      ["personal", "account", "rename", "home", "--dry-run", "--json"],
      given,
      renamingOf(given),
    )
    expect(item.dry_run).toBe(true)
    expect(item.moved).toEqual(
      expect.arrayContaining([
        { kind: "keyring", from: "token:personal", to: "token:home" },
        { kind: "keyring", from: "app-keys:personal", to: "app-keys:home" },
        { kind: "config", from: "profiles.personal", to: "profiles.home" },
        {
          kind: "file",
          from: join(given.root, "state", "sessions", "personal.session"),
          to: join(given.root, "state", "sessions", "home.session"),
        },
        { kind: "store", from: "chat:personal", to: "chat:home" },
        { kind: "store", from: "group family: chat:personal", to: "group family: chat:home" },
      ]),
    )
    expect(given.keyring.get(SERVICE, "token:personal")).toBe("synthetic-token")
    expect(config(given.root).profiles.personal).toEqual({ record: false })
  })

  it("moves the sign-in, the settings, the files and the store's records to the new name", async () => {
    const given = await setup()
    const { code } = await call(["personal", "account", "rename", "home", "--yes", "--json"], given, renamingOf(given))
    expect(code).toBe(0)
    expect(given.keyring.get(SERVICE, "token:home")).toBe("synthetic-token")
    expect(given.keyring.get(SERVICE, "app-keys:home")).toBe("synthetic-keys")
    expect(given.keyring.get(SERVICE, "token:personal")).toBeNull()
    expect(given.keyring.get(SERVICE, "app-keys:work")).toBe("synthetic-keys")
    expect(config(given.root).profiles).toEqual({ home: { record: false }, work: { record: true } })
    expect(existsSync(join(given.root, "state", "sessions", "home.session"))).toBe(true)
    expect(existsSync(join(given.root, "state", "sessions", "personal.session"))).toBe(false)
    expect(existsSync(join(given.root, "state", "media", "home", "photo.jpg"))).toBe(true)
    expect(existsSync(accountFileFor(app, "home", given.env))).toBe(true)
    const store = await openStore({ env: given.env })
    try {
      expect((await store.accounts.profiles()).chat).toEqual({ home: { provider: "telegram", account: "500" } })
      expect((await store.accounts.accountGroups()).family).toEqual(["chat:home", "max:home"])
    } finally {
      await store.close()
    }
  })

  it("moves a path once when a hook repeats it or names a folder holding it", async () => {
    const given = await setup()
    const sessions = (profile: string) => join(given.root, "state", "sessions", `${profile}.session`)
    const { code } = await call(["personal", "account", "rename", "home", "--yes", "--json"], given, {
      ...renamingOf(given),
      stateFiles: (profile) => [sessions(profile), join(given.root, "state", "media", profile, "photo.jpg")],
    })
    expect(code).toBe(0)
    expect(existsSync(sessions("home"))).toBe(true)
    expect(existsSync(join(given.root, "state", "media", "home", "photo.jpg"))).toBe(true)
  })

  it("refuses a name another profile has", async () => {
    const given = await setup()
    const { error } = await call(["personal", "account", "rename", "work", "--yes", "--json"], given, renamingOf(given))
    expect(error.reason).toBe("account-rename.taken")
    expect(given.keyring.get(SERVICE, "token:personal")).toBe("synthetic-token")
  })

  it("names the profiles there are when the old one is unknown", async () => {
    const given = await setup()
    const { error } = await call(["nobody", "account", "rename", "home", "--yes", "--json"], given, renamingOf(given))
    expect(error.reason).toBe("account-rename.unknown-profile")
    expect(error.message).toContain("personal, work")
  })

  it("asks first, and does nothing without --yes when it cannot ask", async () => {
    const given = await setup()
    const { error } = await call(["personal", "account", "rename", "home", "--json"], given, renamingOf(given))
    expect(error.reason).toBe("account-rename.unconfirmed")
    expect(given.keyring.get(SERVICE, "token:personal")).toBe("synthetic-token")
  })

  it("refuses while something holds the profile", async () => {
    const given = await setup()
    const { error } = await call(["personal", "account", "rename", "home", "--yes", "--json"], given, {
      ...renamingOf(given),
      busy: () => "a sync",
    })
    expect(error.reason).toBe("account-rename.busy")
  })

  it("is a messenger's only when its removal says where the sign-in lives", () => {
    const signOut = async () => ({ revoked: null, removed: [] })
    const names = (signIn?: AccountRenaming["signIn"]) =>
      accountCommand({ ...messenger, accountRemoval: { signOut, ...(signIn ? { signIn } : {}) } }).commands.map((one) =>
        one.name(),
      )

    expect(names()).not.toContain("rename")
    expect(names(() => ({}))).toContain("rename")
  })
})
