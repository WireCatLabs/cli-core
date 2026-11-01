import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errorObjectOf, errorRecordOf, type KeyringStore } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import {
  credentialStorage,
  driveSessionCodec,
  type OAuthProvider,
  oauthAccount,
  standardCodec,
  tokenKeeper,
  zoomTokenCodec,
} from "./index.js"

const NOW = 1_800_000_000_000
const folder = () => mkdtempSync(join(tmpdir(), "core-test-oauth-"))

// drive-cli's own check of its entry (drive-cli src/tokens.ts:11-22 on 2026-10-25), copied so a write here is held
// to what drive reads.
const DriveSession = v.object({
  principal: v.string(),
  clientId: v.string(),
  clientSecret: v.optional(v.string()),
  tokens: v.object({
    access_token: v.optional(v.nullable(v.string())),
    refresh_token: v.pipe(v.string(), v.minLength(1)),
    expiry_date: v.optional(v.nullable(v.number())),
    scope: v.optional(v.string()),
    token_type: v.optional(v.nullable(v.string())),
  }),
})

// zoom-cli's own check (zoom-cli src/tokens.ts:104-114 on 2026-10-25).
const zmAccepts = (raw: string) => {
  const value = JSON.parse(raw)
  return (
    typeof value.accessToken === "string" &&
    value.accessToken !== "" &&
    typeof value.refreshToken === "string" &&
    value.refreshToken !== "" &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope: unknown) => typeof scope === "string")
  )
}

const provider = (overrides: Partial<OAuthProvider> = {}): OAuthProvider => ({
  id: "example",
  name: "Example",
  authorizeUrl: "http://127.0.0.1:9/authorize",
  tokenUrl: "http://127.0.0.1:9/token",
  client: { clientId: "declared-client" },
  redirect: { kind: "loopback" },
  ...overrides,
})

const refreshingFetch = (calls: URLSearchParams[], body: Record<string, unknown>) =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(new URLSearchParams(String(init?.body)))
    return Response.json(body)
  }) as typeof fetch

describe("drive's existing entry", () => {
  const driveEntry = {
    principal: "example-principal-1",
    clientId: "saved-client",
    clientSecret: "saved-public-secret",
    tokens: {
      access_token: "synthetic-access-old",
      refresh_token: "synthetic-refresh-1",
      expiry_date: NOW - 1000,
      scope: "scope.read scope.activity",
      token_type: "Bearer",
      id_token: "synthetic-id-token",
    },
  }
  const setup = () => {
    const keyring = memoryKeyring({ "drive-cli:personal": JSON.stringify(driveEntry) })
    const storage = credentialStorage({
      credentials: { service: "drive-cli", configDir: folder(), storage: "keyring", keyring },
      account: "personal",
      codec: driveSessionCodec,
    })
    return { keyring, storage }
  }

  it("is read as it is stored, with the app it was signed in with", () => {
    expect(setup().storage.read()).toEqual({
      client: { clientId: "saved-client", clientSecret: "saved-public-secret" },
      tokens: {
        accessToken: "synthetic-access-old",
        refreshToken: "synthetic-refresh-1",
        expiresAt: NOW - 1000,
        scopes: ["scope.read", "scope.activity"],
        tokenType: "Bearer",
      },
    })
  })

  it("refreshes with the saved app and writes back what drive still reads", async () => {
    const { keyring, storage } = setup()
    const calls: URLSearchParams[] = []
    const keeper = tokenKeeper({
      provider: provider(),
      storage,
      lockDir: folder(),
      fetch: refreshingFetch(calls, { access_token: "synthetic-access-new", expires_in: 3600 }),
      signInCommand: "drive personal session start",
      now: () => NOW,
    })
    expect(await keeper.accessToken()).toBe("synthetic-access-new")
    expect(calls).toHaveLength(1)
    expect(Object.fromEntries(calls[0] ?? [])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "synthetic-refresh-1",
      client_id: "saved-client",
      client_secret: "saved-public-secret",
    })
    const raw = keyring.get("drive-cli", "personal") ?? ""
    expect(v.safeParse(DriveSession, JSON.parse(raw)).success).toBe(true)
    expect(JSON.parse(raw)).toEqual({
      ...driveEntry,
      tokens: { ...driveEntry.tokens, access_token: "synthetic-access-new", expiry_date: NOW + 3_600_000 },
    })
  })

  it("refuses to write a new entry without the account's principal", () => {
    const keyring = memoryKeyring()
    const storage = credentialStorage({
      credentials: { service: "drive-cli", configDir: folder(), storage: "keyring", keyring },
      account: "personal",
      codec: driveSessionCodec,
    })
    const tokens = { accessToken: "a", refreshToken: "r", scopes: [] }
    expect(() => storage.write({ tokens, client: { clientId: "c" } })).toThrow(/principal/)
    storage.write({ tokens, client: { clientId: "c" }, extra: { principal: "example-principal-2" } })
    expect(v.safeParse(DriveSession, JSON.parse(keyring.get("drive-cli", "personal") ?? "")).success).toBe(true)
  })
})

describe("zm's existing entry", () => {
  const zmEntry = {
    accessToken: "synthetic-access-old",
    refreshToken: "synthetic-refresh-1",
    expiresAt: NOW - 1000,
    scopes: ["meeting:read"],
  }
  const zmStorage = (keyring: ReturnType<typeof memoryKeyring>, configDir: string) =>
    credentialStorage({
      credentials: { service: "zoom-cli", configDir, storage: "keyring", keyring },
      account: "zm-client:personal",
      legacyAccounts: ["zm-client"],
      codec: zoomTokenCodec,
    })

  it("is read under zm's own service and account, and refreshed into the same shape", async () => {
    const configDir = folder()
    const keyring = memoryKeyring({ "zoom-cli:zm-client:personal": JSON.stringify(zmEntry) })
    const calls: URLSearchParams[] = []
    const keeper = tokenKeeper({
      provider: provider({ client: { clientId: "zm-client" } }),
      storage: zmStorage(keyring, configDir),
      lockDir: configDir,
      fetch: refreshingFetch(calls, {
        access_token: "synthetic-access-new",
        refresh_token: "synthetic-refresh-2",
        expires_in: 3600,
      }),
      signInCommand: "zm personal session start",
      now: () => NOW,
    })
    expect(await keeper.tokens()).toMatchObject({ scopes: ["meeting:read"], refreshToken: "synthetic-refresh-2" })
    expect(calls[0]?.get("client_id")).toBe("zm-client")
    const raw = keyring.get("zoom-cli", "zm-client:personal") ?? ""
    expect(zmAccepts(raw)).toBe(true)
    expect(JSON.parse(raw)).toEqual({
      accessToken: "synthetic-access-new",
      refreshToken: "synthetic-refresh-2",
      expiresAt: NOW + 3_600_000,
      scopes: ["meeting:read"],
    })
  })

  it("copies the legacy entry to the profile's account and leaves it in place", () => {
    const configDir = folder()
    const keyring = memoryKeyring({ "zoom-cli:zm-client": JSON.stringify(zmEntry) })
    expect(zmStorage(keyring, configDir).read()?.tokens).toEqual(zmEntry)
    expect(keyring.get("zoom-cli", "zm-client:personal")).toBe(JSON.stringify(zmEntry))
    expect(keyring.get("zoom-cli", "zm-client")).toBe(JSON.stringify(zmEntry))
  })
})

describe("new entries", () => {
  it("live under oauth:<provider>:<profile> and round-trip", () => {
    const keyring = memoryKeyring()
    const storage = credentialStorage({
      credentials: { service: "cal-cli", configDir: folder(), storage: "keyring", keyring },
      account: oauthAccount("google", "personal"),
      codec: standardCodec("google"),
    })
    const tokens = { accessToken: "a", refreshToken: "r", expiresAt: NOW, scopes: ["s"], tokenType: "Bearer" }
    storage.write({ tokens, client: { clientId: "c", clientSecret: "never-stored" } })
    expect(JSON.parse(keyring.get("cal-cli", "oauth:google:personal") ?? "")).toEqual({
      version: 1,
      provider: "google",
      clientId: "c",
      ...tokens,
    })
    expect(storage.read()).toEqual({ client: { clientId: "c" }, tokens })
    expect(storage.remove()).toEqual(["keyring"])
    expect(storage.read()).toBeUndefined()
  })

  it("stay in the file on a refresh and move back to the keyring on a sign-in", () => {
    const configDir = folder()
    const keyring = memoryKeyring()
    const storageIn = (storage: "auto" | "file") =>
      credentialStorage({
        credentials: { service: "cal-cli", configDir, storage, keyring, env: {}, warn: () => {} },
        account: oauthAccount("google", "personal"),
        codec: standardCodec("google"),
      })
    const tokens = { accessToken: "a", refreshToken: "r", expiresAt: NOW, scopes: ["s"], tokenType: "Bearer" }
    storageIn("file").write({ tokens, client: { clientId: "c" } })

    storageIn("auto").write({ tokens: { ...tokens, accessToken: "refreshed" }, client: { clientId: "c" } })
    expect(keyring.get("cal-cli", "oauth:google:personal")).toBeNull()

    storageIn("auto").write({ tokens, client: { clientId: "c" } }, { signIn: true })
    expect(keyring.get("cal-cli", "oauth:google:personal")).not.toBeNull()
    expect(storageIn("file").read()).toBeUndefined()
  })

  it("need a profile and a keyring passed in", () => {
    expect(() => oauthAccount("google", " ")).toThrow(/profile/)
    expect(() =>
      credentialStorage({
        credentials: { service: "cal-cli", configDir: folder() },
        account: "a",
        codec: standardCodec("google"),
      }),
    ).toThrow(/keyring/)
  })
})

it("never quotes an unreadable entry in its error", () => {
  const secret = "synthetic-secret-in-broken-json"
  for (const codec of [standardCodec("google"), driveSessionCodec, zoomTokenCodec])
    for (const raw of [`{"refreshToken": "${secret}"`, JSON.stringify({ refreshToken: secret }), "[]"]) {
      let message = ""
      try {
        codec.decode(raw)
      } catch (error) {
        message = String((error as Error).message)
      }
      expect(message).toMatch(/cannot be read/)
      expect(message).not.toContain(secret)
    }
})

describe("a keyring that cannot be reached", () => {
  const SECRET = "synthetic-refresh-keyring-echo"
  const refusing: KeyringStore = {
    get: () => {
      throw new Error("Platform failure: DBus error: Failed to connect to socket /run/user/1000/bus")
    },
    set: (_service, _account, secret) => {
      throw new Error(`No storage access: collection is locked, could not store ${secret}`)
    },
    delete: () => {
      throw new Error("No storage access: collection is locked")
    },
  }
  const storage = (keyring = refusing) =>
    credentialStorage({
      credentials: { service: "cal-cli", configDir: folder(), storage: "keyring", keyring },
      account: oauthAccount("google", "personal"),
      codec: standardCodec("google"),
    })
  const failureOf = (act: () => unknown) => {
    try {
      act()
    } catch (error) {
      return error
    }
    throw new Error("expected a failure")
  }

  it("keeps the keyring's reason for --debug and the run record, not for the answer", () => {
    const failure = failureOf(() => storage().read())
    const object = errorObjectOf(failure)
    expect(object.error.code).toBe("configuration_error")
    expect(JSON.stringify(object)).not.toContain("DBus")
    expect(
      errorRecordOf(failure, object, { command: "session status", service: "cal-cli", version: "0" }),
    ).toMatchObject({ attributes: { cause: expect.stringContaining("Failed to connect to socket") } })
  })

  it("never carries the secret it failed to save", () => {
    const failure = failureOf(() =>
      storage({ ...refusing, get: () => null }).write({
        client: { clientId: "client" },
        tokens: { accessToken: "a", refreshToken: SECRET, expiresAt: NOW, scopes: [] },
      }),
    )
    const cause = (failure as Error).cause as Error
    expect(cause.message).toContain("collection is locked")
    expect(cause.message).not.toContain(SECRET)
  })
})
