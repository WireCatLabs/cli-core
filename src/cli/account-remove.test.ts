import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams, type KeyringStore } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { lockPath } from "../background/lock.js"
import type { ServerSystem } from "../background/system.js"
import { unitScope } from "../background/units.js"
import { credentialStorage, oauthAccount, standardCodec, tokenKeeper } from "../oauth/index.js"
import { openStore } from "../store/store.js"
import { messenger } from "../testing/shared-program.js"
import { type AccountRemoval, type AccountRemovalContext, accountRemoveCommand, mayRevoke } from "./account-remove.js"
import { accountCommand } from "./messenger/account-command.js"
import { accountFileFor, rememberAccount } from "./messenger/accounts.js"
import { run } from "./program.js"
import { settingsFor } from "./settings.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "synthetic", version: "1.0.0" }
const SERVICE = "chat-cli"

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), "account-remove-"))
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
  for (const [profile, account] of [
    ["personal", "500"],
    ["work", "600"],
  ] as const) {
    await store.accounts.saveAccount({ provider: "telegram", account }, { name: profile })
    await store.accounts.saveProfile("chat", profile, { provider: "telegram", account })
  }
  await store.close()
  const session = join(root, "state", "sessions", "personal.session")
  const media = join(root, "state", "media", "personal")
  mkdirSync(join(root, "state", "sessions"), { recursive: true })
  mkdirSync(media, { recursive: true })
  writeFileSync(session, "synthetic")
  writeFileSync(join(media, "photo.jpg"), "synthetic")
  const keyring = memoryKeyring({
    [`${SERVICE}:app-keys:personal`]: "synthetic-secret",
    [`${SERVICE}:app-keys:work`]: "synthetic-secret",
  })
  return { root, env, keyring, session, media }
}

type Setup = Awaited<ReturnType<typeof setup>>

const removalOf = ({ root, session, media }: Setup, calls: AccountRemovalContext[] = []): AccountRemoval => ({
  signOut: async (profile, context) => {
    calls.push(context)
    return { revoked: context.mayRevoke, removed: [`the ${profile} session`] }
  },
  account: (profile) => ({ provider: "telegram", account: profile === "personal" ? "500" : "600" }),
  secrets: (profile) => [
    { credentials: { service: SERVICE, configDir: join(root, "config") }, accounts: [`app-keys:${profile}`] },
  ],
  stateFiles: (profile) => (profile === "personal" ? [session] : []),
  dataFiles: (profile) => (profile === "personal" ? [media] : []),
})

const machine = () => {
  const ran: string[][] = []
  const system: ServerSystem = {
    platform: "linux",
    uid: 501,
    entry: ["/opt/node", "/opt/chat/bin/chat.js"],
    run: async (argv) => {
      ran.push(argv)
      return { code: 0, stdout: "", stderr: "" }
    },
    spawn: () => 0,
    pause: async () => {},
  }
  return { system, ran }
}

const call = async (
  argv: string[],
  { env, keyring, ownerHome }: { env: NodeJS.ProcessEnv; keyring: KeyringStore; ownerHome?: string },
  removal: AccountRemoval,
  system: ServerSystem = machine().system,
) => {
  const streams = captureStreams()
  const code = await run(
    argv,
    {
      app,
      commands: () => [
        new Command("account").addCommand(
          accountRemoveCommand(app, removal, {
            resolveSettings: settingsFor(app).resolveSettings,
            ...(ownerHome === undefined ? {} : { ownerHome }),
          }),
        ),
      ],
    },
    { streams, tty: false, env, keyring, system },
  )
  const out = streams.stdout.join("")
  const err = streams.stderr.join("")
  return {
    code,
    item: out ? JSON.parse(out).item : undefined,
    error: err.startsWith("{") ? JSON.parse(err).error : undefined,
  }
}

const storeState = async (env: NodeJS.ProcessEnv) => {
  const store = await openStore({ env })
  try {
    return {
      accounts: (await store.accounts.accounts()).map((key) => key.account),
      profiles: Object.keys((await store.accounts.profiles()).chat ?? {}),
    }
  } finally {
    await store.close()
  }
}

const config = (root: string) => JSON.parse(readFileSync(join(root, "config", "config.json"), "utf8"))

describe("account remove", () => {
  it("refuses to choose for the owner what happens to the data", async () => {
    const given = await setup()
    const result = await call(["personal", "--json", "account", "remove", "--yes"], given, removalOf(given))

    expect(result.error).toMatchObject({ code: "validation_error", reason: "account-remove.no-choice" })
    expect(existsSync(given.session)).toBe(true)
  })

  it("lists every entry, section and file under --dry-run, and changes nothing", async () => {
    const given = await setup()
    const calls: AccountRemovalContext[] = []
    const result = await call(
      ["personal", "--json", "account", "remove", "--delete-data", "--dry-run"],
      given,
      removalOf(given, calls),
    )

    expect(result.code).toBe(0)
    expect(result.item).toMatchObject({ profile: "personal", data: "deleted", dry_run: true, revoked: null })
    expect(result.item.removed).toEqual(
      expect.arrayContaining([
        { kind: "keyring", target: "app-keys:personal" },
        { kind: "config", target: "profiles.personal" },
        { kind: "file", target: accountFileFor(app, "personal", given.env) },
        { kind: "file", target: given.session },
        { kind: "file", target: given.media },
        { kind: "store", target: "telegram:500" },
      ]),
    )
    expect(calls).toEqual([])
    expect(existsSync(given.media)).toBe(true)
    expect((await storeState(given.env)).accounts).toContain("500")
  })

  it("answers confirmation_required under --json without --yes, before signing out", async () => {
    const given = await setup()
    const calls: AccountRemovalContext[] = []
    const result = await call(
      ["personal", "--json", "account", "remove", "--keep-data"],
      given,
      removalOf(given, calls),
    )

    expect(result.error).toMatchObject({ code: "confirmation_required", reason: "account-remove.unconfirmed" })
    expect(calls).toEqual([])
    expect(config(given.root).profiles.personal).toBeDefined()
  })

  it("with --keep-data signs out and forgets the profile, and the store keeps its account", async () => {
    const given = await setup()
    const calls: AccountRemovalContext[] = []
    const result = await call(
      ["personal", "--json", "account", "remove", "--keep-data", "--yes"],
      given,
      removalOf(given, calls),
    )

    expect(result.code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.mayRevoke).toBe(true)
    expect(result.item).toMatchObject({ data: "kept", dry_run: false, revoked: true })
    expect(result.item.removed).toContainEqual({ kind: "sign_in", target: "the personal session" })
    expect(result.item.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "store", target: "telegram:500" }),
        expect.objectContaining({ kind: "file", target: given.media }),
      ]),
    )
    expect(given.keyring.get(SERVICE, "app-keys:personal")).toBeNull()
    expect(given.keyring.get(SERVICE, "app-keys:work")).toBe("synthetic-secret")
    expect(existsSync(accountFileFor(app, "personal", given.env))).toBe(false)
    expect(existsSync(accountFileFor(app, "work", given.env))).toBe(true)
    expect(existsSync(given.session)).toBe(false)
    expect(existsSync(given.media)).toBe(true)
    expect(config(given.root).profiles).toEqual({ work: { record: true } })
    expect(await storeState(given.env)).toEqual({ accounts: ["500", "600"], profiles: ["personal", "work"] })
  })

  it("with --delete-data purges the account from the store and deletes its files, and the other profile stays", async () => {
    const given = await setup()
    const result = await call(
      ["personal", "--json", "account", "remove", "--delete-data", "--yes"],
      given,
      removalOf(given),
    )

    expect(result.code).toBe(0)
    expect(result.item.removed).toContainEqual({ kind: "store", target: "telegram:500" })
    expect(result.item.kept).toEqual([])
    expect(existsSync(given.media)).toBe(false)
    expect(await storeState(given.env)).toEqual({ accounts: ["600"], profiles: ["work"] })
  })

  it("**removes nothing in the owner's folders when only the config folder is moved** (WC-SECR-24)", async () => {
    const root = mkdtempSync(join(tmpdir(), "account-remove-moved-config-"))
    const env: NodeJS.ProcessEnv = { HOME: root, CHAT_CONFIG_DIR: join(root, "moved-config") }
    mkdirSync(join(root, "moved-config"), { recursive: true })
    writeFileSync(join(root, "moved-config", "config.json"), JSON.stringify({ profiles: { personal: {} } }))
    rememberAccount(app, "personal", "500", env)
    const store = await openStore({ env })
    await store.accounts.saveAccount({ provider: "telegram", account: "500" }, { name: "personal" })
    await store.accounts.saveProfile("chat", "personal", { provider: "telegram", account: "500" })
    await store.close()
    const state = join(root, ".local", "share", "chat-cli")
    const session = join(state, "sessions", "personal.session")
    const lock = lockPath(app, "personal", env)
    for (const file of [session, lock]) {
      mkdirSync(join(file, ".."), { recursive: true })
      writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 1, startedAt: new Date(0).toISOString() }))
    }
    const keyring = memoryKeyring()
    const removal: AccountRemoval = {
      signOut: async () => ({ revoked: null, removed: [] }),
      account: () => ({ provider: "telegram", account: "500" }),
      stateFiles: () => [session],
      dataFiles: () => [join(state, "media")],
    }

    const result = await call(
      ["personal", "--json", "account", "remove", "--delete-data", "--yes"],
      { env, keyring, ownerHome: root },
      removal,
    )

    expect(result.code).toBe(0)
    expect(result.item.removed.filter(({ kind }: { kind: string }) => kind === "file" || kind === "store")).toEqual([])
    expect(result.item.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", target: accountFileFor(app, "personal", env) }),
        expect.objectContaining({ kind: "file", target: session }),
        expect.objectContaining({ kind: "file", target: lock }),
        expect.objectContaining({ kind: "store", target: "telegram:500" }),
      ]),
    )
    for (const file of [accountFileFor(app, "personal", env), session, lock]) expect(existsSync(file)).toBe(true)
    expect((await storeState(env)).accounts).toEqual(["500"])
  })

  it("**never runs the tool's sign-out when only the config folder is moved**: it would end the owner's session (WC-SECR-24)", async () => {
    const root = mkdtempSync(join(tmpdir(), "account-remove-moved-signout-"))
    const env: NodeJS.ProcessEnv = { HOME: root, CHAT_CONFIG_DIR: join(root, "moved-config") }
    mkdirSync(join(root, "moved-config"), { recursive: true })
    writeFileSync(join(root, "moved-config", "config.json"), JSON.stringify({ profiles: { personal: {} } }))
    const device = join(root, ".local", "share", "chat-cli", "personal", "device.db")
    mkdirSync(join(device, ".."), { recursive: true })
    writeFileSync(device, "synthetic")
    const removal: AccountRemoval = {
      signOut: async () => {
        rmSync(device, { force: true })
        return { revoked: false, removed: ["the personal device"] }
      },
      account: () => ({ provider: "telegram", account: "500" }),
    }

    const result = await call(
      ["personal", "--json", "account", "remove", "--keep-data", "--yes"],
      { env, keyring: memoryKeyring(), ownerHome: root },
      removal,
    )

    expect(result.code).toBe(0)
    expect(existsSync(device)).toBe(true)
    expect(result.item.removed.filter(({ kind }: { kind: string }) => kind === "sign_in")).toEqual([])
    expect(result.item.kept).toContainEqual(expect.objectContaining({ kind: "sign_in" }))
  })

  it("**keeps the owner's config when the moved config folder is a link to it** (WC-SECR-24)", async () => {
    const root = mkdtempSync(join(tmpdir(), "account-remove-linked-config-"))
    const owners = join(root, ".config", "chat-cli")
    mkdirSync(owners, { recursive: true })
    const written = JSON.stringify({ profiles: { personal: {} } })
    writeFileSync(join(owners, "config.json"), written)
    symlinkSync(owners, join(root, "linked-config"))
    const env: NodeJS.ProcessEnv = { HOME: root, CHAT_CONFIG_DIR: join(root, "linked-config") }

    const result = await call(
      ["personal", "--json", "account", "remove", "--keep-data", "--yes"],
      { env, keyring: memoryKeyring(), ownerHome: root },
      {
        signOut: async () => ({ revoked: null, removed: [] }),
        account: () => ({ provider: "telegram", account: "500" }),
      },
    )

    expect(result.code).toBe(0)
    expect(readFileSync(join(owners, "config.json"), "utf8")).toBe(written)
  })

  it("refuses while a serve runs for the profile, or the tool says a sync holds it", async () => {
    const given = await setup()
    const lock = lockPath(app, "personal", given.env)
    mkdirSync(join(lock, ".."), { recursive: true })
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    const serving = await call(
      ["personal", "--json", "account", "remove", "--keep-data", "--yes"],
      given,
      removalOf(given),
    )
    const syncing = await call(["work", "--json", "account", "remove", "--keep-data", "--yes"], given, {
      ...removalOf(given),
      busy: () => "`chat work sync`",
    })

    expect(serving.error).toMatchObject({ code: "conflict", reason: "account-remove.busy" })
    expect(syncing.error).toMatchObject({ code: "conflict", reason: "account-remove.busy" })
    expect(existsSync(given.session)).toBe(true)
  })

  it("refuses a hook's path outside the tool's own folders before removing anything", async () => {
    const given = await setup()
    const result = await call(["personal", "--json", "account", "remove", "--delete-data", "--yes"], given, {
      ...removalOf(given),
      dataFiles: () => [given.root],
    })

    expect(result.error).toMatchObject({ code: "configuration_error", reason: "account-remove.path-outside" })
    expect(existsSync(given.session)).toBe(true)
  })

  it("answers not_found for a profile this computer does not have", async () => {
    const given = await setup()
    const result = await call(["other", "--json", "account", "remove", "--keep-data", "--yes"], given, removalOf(given))

    expect(result.error).toMatchObject({ code: "not_found", reason: "account-remove.unknown-profile" })
  })

  it("keeps everything when the sign-out fails", async () => {
    const given = await setup()
    const result = await call(["personal", "--json", "account", "remove", "--delete-data", "--yes"], given, {
      ...removalOf(given),
      signOut: async () => {
        throw new Error("synthetic sign-out failure")
      },
    })

    expect(result.code).not.toBe(0)
    expect(existsSync(given.session)).toBe(true)
    expect(given.keyring.get(SERVICE, "app-keys:personal")).toBe("synthetic-secret")
    expect((await storeState(given.env)).accounts).toContain("500")
  })
})

describe("account remove of an OAuth sign-in", () => {
  const OAUTH_ENTRY = "oauth:example:personal"

  const signedInRemoval = (given: Setup, answer: Response) => {
    const revokes: string[] = []
    const fetch = (async (url: string | URL | Request) => {
      revokes.push(String(url))
      return answer
    }) as typeof globalThis.fetch
    given.keyring.set(
      SERVICE,
      OAUTH_ENTRY,
      JSON.stringify({
        version: 1,
        provider: "example",
        clientId: "synthetic-client",
        scopes: ["s"],
        refreshToken: "synthetic-refresh",
      }),
    )
    const storage = credentialStorage({
      credentials: {
        service: SERVICE,
        configDir: join(given.root, "config"),
        storage: "keyring",
        keyring: given.keyring,
      },
      account: oauthAccount("example", "personal"),
      codec: standardCodec("example"),
    })
    const keeper = tokenKeeper({
      provider: {
        id: "example",
        name: "Example",
        authorizeUrl: "https://example.test/authorize",
        tokenUrl: "https://example.test/token",
        revokeUrl: "https://example.test/revoke",
        client: { clientId: "synthetic-client" },
        redirect: { kind: "loopback" },
      },
      storage,
      lockDir: join(given.root, "config"),
      fetch,
      signInCommand: "chat personal session start",
    })
    const removal: AccountRemoval = {
      ...removalOf(given),
      signOut: async (_profile, context) => {
        const { revoked } = await keeper.signOut({ revoke: context.mayRevoke })
        return { revoked, removed: ["the personal sign-in"] }
      },
    }
    return { removal, revokes }
  }

  it("finishes when Google already dropped the grant (400 invalid_token)", async () => {
    const given = await setup()
    const { removal, revokes } = signedInRemoval(given, Response.json({ error: "invalid_token" }, { status: 400 }))
    const result = await call(["personal", "--json", "account", "remove", "--keep-data", "--yes"], given, removal)

    expect(result.code).toBe(0)
    expect(result.item).toMatchObject({ revoked: true })
    expect(revokes).toEqual(["https://example.test/revoke"])
    expect(given.keyring.get(SERVICE, OAUTH_ENTRY)).toBeNull()
  })

  it("keeps the sign-in when the provider refuses the revoke for another reason", async () => {
    const given = await setup()
    const { removal } = signedInRemoval(given, Response.json({ error: "invalid_request" }, { status: 400 }))
    const result = await call(["personal", "--json", "account", "remove", "--keep-data", "--yes"], given, removal)

    expect(result.code).not.toBe(0)
    expect(result.error).toMatchObject({ code: "outcome_unknown", reason: "oauth.revoke-failed" })
    expect(given.keyring.get(SERVICE, OAUTH_ENTRY)).not.toBeNull()
  })
})

describe("a messenger's account group", () => {
  it("has remove only when the messenger opts in", () => {
    const { accountRemoval: _, ...without } = messenger
    const names = (removal?: AccountRemoval) =>
      accountCommand({ ...without, ...(removal ? { accountRemoval: removal } : {}) }).commands.map((one) => one.name())

    expect(names()).not.toContain("remove")
    expect(names({ signOut: async () => ({ revoked: null, removed: [] }) })).toContain("remove")
  })
})

describe("account remove and what cli-core keeps for the profile", () => {
  const stateOf = ({ root }: Setup, ...parts: string[]) => join(root, "state", ...parts)
  const write = (path: string, text = "{}") => {
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, text)
  }

  it("removes cli-core's own files of the profile, its serve unit and its schedules, and keeps the sends journal", async () => {
    const given = await setup()
    const own = [
      stateOf(given, "flood", "personal.json"),
      stateOf(given, "pace", "personal.json"),
      stateOf(given, "profiles", "personal.recipients.json"),
      stateOf(given, "provider-log", "personal.jsonl"),
      stateOf(given, "mcp-http", "personal.json"),
      stateOf(given, "personal.replies-state.json"),
      stateOf(given, "inbox", "personal.json"),
      stateOf(given, "schedule-daily-review", "personal.json"),
      stateOf(given, "checkpoints", "personal", "sync.json"),
    ]
    for (const file of own) write(file)
    const others = stateOf(given, "flood", "work.json")
    const journal = stateOf(given, "sends", "personal.jsonl")
    write(others)
    write(journal, "")
    const unitFor = (profile: string) =>
      join(given.root, "xdg", "systemd", "user", `chat-serve-${unitScope(app, profile, given.env)}.service`)
    write(unitFor("personal"), "")
    write(unitFor("work"), "")
    const schedule = (name: string, profile: string) =>
      write(
        stateOf(given, "schedules", name, "schedule.json"),
        JSON.stringify({
          name,
          kind: "command",
          argv: ["inbox"],
          when: { every: 60 },
          environment: { CHAT_PROFILE: profile },
          createdAt: "2026-11-08T00:00:00Z",
        }),
      )
    schedule("daily", "personal")
    schedule("nightly", "work")
    const { system, ran } = machine()

    const dry = await call(
      ["personal", "--json", "account", "remove", "--keep-data", "--dry-run"],
      given,
      removalOf(given),
      system,
    )
    expect(dry.item.removed).toEqual(
      expect.arrayContaining([
        ...own.slice(0, -1).map((target) => ({ kind: "file", target })),
        { kind: "file", target: stateOf(given, "checkpoints", "personal") },
        { kind: "unit", target: unitFor("personal") },
        { kind: "schedule", target: "daily" },
      ]),
    )
    expect(ran.filter((argv) => argv.includes("disable"))).toEqual([])

    const result = await call(
      ["personal", "--json", "account", "remove", "--keep-data", "--yes"],
      given,
      removalOf(given),
      system,
    )

    expect(result.code).toBe(0)
    for (const file of own) expect(existsSync(file)).toBe(false)
    expect(existsSync(unitFor("personal"))).toBe(false)
    expect(existsSync(stateOf(given, "schedules", "daily", "schedule.json"))).toBe(false)
    expect(existsSync(others)).toBe(true)
    expect(existsSync(unitFor("work"))).toBe(true)
    expect(existsSync(stateOf(given, "schedules", "nightly", "schedule.json"))).toBe(true)
    expect(existsSync(journal)).toBe(true)
    expect(result.item.kept).toContainEqual({
      kind: "file",
      target: journal,
      reason: "the record of what was sent for this account",
    })
    const disabled = ran.map((argv) => argv.join(" ")).filter((line) => line.includes("disable"))
    expect(disabled.some((line) => line.includes("chat-schedule-daily.timer"))).toBe(true)
    expect(disabled.some((line) => line.includes("nightly") || line.includes("serve-work"))).toBe(false)
  })

  it("lets a hook's paths lie in the tool's own extra folders inside the home folder", async () => {
    const given = await setup()
    const extra = join(given.root, ".local", "share", "zm")
    const checkpoint = join(extra, "checkpoints", "personal")
    write(join(checkpoint, "meetings.json"))
    const result = await call(["personal", "--json", "account", "remove", "--keep-data", "--yes"], given, {
      ...removalOf(given),
      ownFolders: ({ env }) => [join(env.HOME as string, ".local", "share", "zm")],
      stateFiles: () => [checkpoint],
    })

    expect(result.code).toBe(0)
    expect(existsSync(checkpoint)).toBe(false)
  })

  it("refuses an extra folder that is relative, outside the home folder or the home folder itself", async () => {
    const given = await setup()
    for (const folder of ["relative/zm", join(tmpdir(), "elsewhere-zm"), given.root]) {
      const result = await call(["personal", "--json", "account", "remove", "--keep-data", "--yes"], given, {
        ...removalOf(given),
        ownFolders: () => [folder],
      })

      expect(result.error).toMatchObject({ code: "configuration_error", reason: "account-remove.folder-outside" })
    }
    expect(existsSync(given.session)).toBe(true)
  })
})

describe("mayRevoke", () => {
  it("**never lets a run with a moved folder revoke the owner's sign-in**; a test's own keyring may", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "may-revoke-"))

    expect(mayRevoke(app, { CHAT_CONFIG_DIR: elsewhere })).toBe(false)
    expect(mayRevoke(app, { CHAT_CACHE_DIR: elsewhere })).toBe(false)
    expect(mayRevoke(app, { CHAT_CONFIG_DIR: elsewhere }, memoryKeyring())).toBe(true)
  })
})
