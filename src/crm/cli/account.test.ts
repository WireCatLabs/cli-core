import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { captureStreams, type KeyringStore } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { accountFileFor, recalledAccount, rememberAccount } from "../../cli/messenger/accounts.js"
import { ProfileTokenStore } from "../../cli/profile-token.js"
import { run } from "../../cli/program.js"
import { settingsFor } from "../../cli/settings.js"
import { tokenSessionCommand } from "../../cli/token-session.js"
import type { AppIdentity } from "../../ports/app.js"
import { openStore } from "../../store/store.js"
import { type CrmAccountOptions, type CrmHeld, crmAccountClaim, refuseTakenCrmAccount } from "./account.js"
import { addCrmCommands } from "./index.js"

const APP: AppIdentity = {
  command: "crm",
  appName: "example-crm-cli",
  envPrefix: "CRM",
  description: "synthetic",
  version: "1.0.0",
}
const PROVIDER = "example-crm"
const ACCOUNT: CrmAccountOptions = { provider: PROVIDER, service: "Example CRM" }

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const setup = async (accounts: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "crm-account-"))
  roots.push(root)
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "xdg"),
    CRM_STATE_DIR: join(root, "state"),
    CRM_CONFIG_DIR: join(root, "config"),
    CRM_CACHE_DIR: join(root, "cache"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  mkdirSync(join(root, "config"), { recursive: true })
  writeFileSync(
    join(root, "config", "config.json"),
    JSON.stringify({ profiles: Object.fromEntries(Object.keys(accounts).map((name) => [name, {}])) }),
  )
  const keyring = memoryKeyring()
  const tokens = new ProfileTokenStore({ app: APP, env, keyring })
  const store = await openStore({ env })
  for (const [profile, account] of Object.entries(accounts)) {
    rememberAccount(APP, profile, account, env)
    tokens.write(profile, `synthetic-${profile}`)
    await store.accounts.saveAccount({ provider: PROVIDER, account }, { name: profile })
    await store.accounts.saveProfile(APP.command, profile, { provider: PROVIDER, account })
  }
  await store.close()
  const cursors = join(root, "state", "crm", "personal")
  mkdirSync(cursors, { recursive: true })
  return { root, env, keyring, tokens, cursors }
}

const call = async (
  argv: string[],
  { env, keyring }: { env: NodeJS.ProcessEnv; keyring: KeyringStore },
  account: CrmAccountOptions = ACCOUNT,
) => {
  const streams = captureStreams()
  const code = await run(
    argv,
    {
      app: APP,
      commands: () => {
        const holder = new Command(APP.command)
        addCrmCommands(holder, {
          app: APP,
          open: () => Promise.reject(new Error("account remove opens no CRM")),
          account: { ...account, resolveSettings: settingsFor(APP).resolveSettings },
        })
        return [...holder.commands]
      },
    },
    { streams, tty: false, env, keyring },
  )
  const out = streams.stdout.join("")
  const err = streams.stderr.join("")
  return {
    code,
    item: out ? JSON.parse(out).item : undefined,
    error: err.startsWith("{") ? JSON.parse(err).error : undefined,
    err,
  }
}

const accountsInStore = async (env: NodeJS.ProcessEnv) => {
  const store = await openStore({ env })
  try {
    return (await store.accounts.accounts()).map((key) => key.account)
  } finally {
    await store.close()
  }
}

describe("account remove of a CRM", () => {
  it("refuses --delete-data while another profile, even one whose session ended, reads the same account", async () => {
    const given = await setup({ personal: "portal-1", work: "portal-1" })
    given.tokens.remove("work")
    const result = await call(["personal", "--json", "account", "remove", "--delete-data", "--yes"], given)

    expect(result.error).toMatchObject({
      code: "conflict",
      reason: "account-remove.account-shared",
      details: { profiles: ["work"], account: "portal-1" },
    })
    expect(result.error.message).toContain("work also reads Example CRM account portal-1")
    expect(await accountsInStore(given.env)).toEqual(["portal-1"])
    expect(given.tokens.read("personal")).toBeDefined()
  })

  it("only warns under --dry-run, and lists what --delete-data would remove", async () => {
    const given = await setup({ personal: "portal-1", work: "portal-1" })
    const result = await call(["personal", "--json", "account", "remove", "--delete-data", "--dry-run"], given)

    expect(result.code).toBe(0)
    expect(result.err).toContain("without --dry-run this refuses: work also reads Example CRM account portal-1")
    expect(result.item).toMatchObject({ dry_run: true, account: { provider: PROVIDER, account: "portal-1" } })
    expect(result.item.removed).toEqual(
      expect.arrayContaining([
        { kind: "keyring", target: "token:personal" },
        { kind: "file", target: given.cursors },
        { kind: "store", target: `${PROVIDER}:portal-1` },
      ]),
    )
  })

  it("keeps the shared copy with --keep-data and forgets the profile's sign-in, account and cursors", async () => {
    const given = await setup({ personal: "portal-1", work: "portal-1" })
    const result = await call(["personal", "--json", "account", "remove", "--keep-data", "--yes"], given)

    expect(result.code).toBe(0)
    expect(result.item.removed).toEqual(
      expect.arrayContaining([
        { kind: "sign_in", target: expect.stringContaining("stays valid in Example CRM") },
        { kind: "keyring", target: "token:personal" },
      ]),
    )
    expect(given.tokens.read("personal")).toBeUndefined()
    expect(existsSync(accountFileFor(APP, "personal", given.env))).toBe(false)
    expect(existsSync(given.cursors)).toBe(false)
    expect(await accountsInStore(given.env)).toEqual(["portal-1"])
  })

  it("deletes the account's copy when no other profile reads it", async () => {
    const given = await setup({ personal: "portal-1", work: "portal-2" })
    const result = await call(["personal", "--json", "account", "remove", "--delete-data", "--yes"], given)

    expect(result.code).toBe(0)
    expect(await accountsInStore(given.env)).toEqual(["portal-2"])
  })

  it("never removes a folder every account shares, even for a profile named after it", async () => {
    const given = await setup({ files: "portal-1", work: "portal-2" })
    const downloads = join(given.root, "state", "crm", "files", `${PROVIDER}-portal-2`)
    const counts = join(given.root, "state", "crm", "foreign-contacts")
    mkdirSync(downloads, { recursive: true })
    mkdirSync(counts, { recursive: true })
    const result = await call(["files", "--json", "account", "remove", "--delete-data", "--yes"], given)

    expect(result.code).toBe(0)
    expect(result.item.removed).not.toContainEqual({ kind: "file", target: join(given.root, "state", "crm", "files") })
    expect(existsSync(downloads)).toBe(true)
    expect(existsSync(counts)).toBe(true)
    expect(await accountsInStore(given.env)).toEqual(["portal-2"])
  })

  it("asks the CLI's own hook which account a profile holds, and takes its own sign-out", async () => {
    const given = await setup({ personal: "remembered-1", work: "remembered-2" })
    const held = (): CrmHeld => ({ account: "portal-9", signedIn: true })
    const result = await call(["personal", "--json", "account", "remove", "--delete-data", "--yes"], given, {
      ...ACCOUNT,
      held,
      removal: { signOut: async () => ({ revoked: null, removed: ["the webhook of personal"] }) },
    })

    expect(result.error).toMatchObject({ reason: "account-remove.account-shared", details: { account: "portal-9" } })
  })
})

describe("a second sign-in to a CRM account", () => {
  const signIn = async (given: Awaited<ReturnType<typeof setup>>, profile: string, id: string) => {
    const streams = captureStreams()
    const code = await run(
      [profile, "--json", "session", "start"],
      {
        app: APP,
        commands: () => [
          tokenSessionCommand({
            app: APP,
            service: "Example CRM",
            resolveSettings: settingsFor(APP).resolveSettings,
            claim: crmAccountClaim(APP, ACCOUNT),
            verify: async () => ({ id, account: { id } }),
          }),
        ],
      },
      { streams, tty: false, env: given.env, keyring: given.keyring, stdin: Readable.from(["synthetic-token\n"]) },
    )
    const err = streams.stderr.join("")
    return { code, error: err.startsWith("{") ? JSON.parse(err).error : undefined }
  }

  it("is refused while another profile is signed in to the account, and taken once that session ends", async () => {
    const given = await setup({ work: "portal-1" })

    const refused = await signIn(given, "personal", "portal-1")
    expect(refused.error).toMatchObject({
      code: "conflict",
      reason: "session.duplicate",
      details: { profile: "work", account: "portal-1" },
    })
    expect(refused.error.message).toContain("profile work already signs in to Example CRM account portal-1")
    expect(given.tokens.read("personal")).toBeUndefined()

    given.tokens.remove("work")
    expect((await signIn(given, "personal", "portal-1")).code).toBe(0)
    expect(recalledAccount(APP, PROVIDER, "personal", given.env)?.account).toBe("portal-1")
  })

  it("compares the user too where one account has several, and counts no token from the environment", async () => {
    const given = await setup({ work: "portal-1", sales: "portal-1" })
    const users: Record<string, string> = { work: "5", sales: "7" }
    const options: CrmAccountOptions = {
      ...ACCOUNT,
      held: (profile, { env, keyring }) => {
        const saved = new ProfileTokenStore({ app: APP, env, ...(keyring ? { keyring } : {}) }).read(profile)
        const user = users[profile]
        if (user === undefined) return undefined
        return { account: "portal-1", user, signedIn: saved !== undefined && saved.source !== "environment" }
      },
    }
    const where = { env: given.env, keyring: given.keyring, profile: "personal" }

    expect(() => refuseTakenCrmAccount(APP, options, where, { account: "portal-1", user: "6" })).not.toThrow()
    expect(() => refuseTakenCrmAccount(APP, options, where, { account: "portal-1", user: "7" })).toThrow(
      "profile sales already signs in to Example CRM account portal-1 as user 7",
    )

    given.tokens.remove("work")
    given.tokens.remove("sales")
    const fromVariable = { ...where, env: { ...given.env, CRM_TOKEN: "synthetic" } }
    expect(() => refuseTakenCrmAccount(APP, ACCOUNT, fromVariable, { account: "portal-1" })).not.toThrow()
  })

  it("passes over a profile whose sign-in cannot be read", () => {
    const failing: CrmAccountOptions = {
      ...ACCOUNT,
      held: () => {
        throw new Error("keyring.unreachable")
      },
    }
    const root = mkdtempSync(join(tmpdir(), "crm-account-"))
    roots.push(root)
    const env = { HOME: root, CRM_STATE_DIR: join(root, "state"), CRM_CONFIG_DIR: join(root, "config") }
    rememberAccount(APP, "work", "portal-1", env)

    expect(() =>
      refuseTakenCrmAccount(APP, failing, { env, profile: "personal", profiles: ["work"] }, { account: "portal-1" }),
    ).not.toThrow()
  })
})
