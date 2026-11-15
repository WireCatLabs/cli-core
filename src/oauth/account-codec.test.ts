import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { describe, expect, it } from "vitest"
import { accountTokenCodec, credentialStorage, oauthAccount, tokenKeeper } from "./index.js"

const NOW = 1_800_000_000_000
const folder = () => mkdtempSync(join(tmpdir(), "core-test-account-codec-"))
const ACCOUNT = oauthAccount("amocrm", "work")
const entry = {
  version: 1,
  provider: "amocrm",
  clientId: "owner-integration",
  clientSecret: "synthetic-owner-secret",
  host: "https://example.amocrm.ru",
  userId: "7",
  accessToken: "synthetic-access-old",
  refreshToken: "synthetic-refresh-1",
  expiresAt: NOW - 1000,
  scopes: [],
}

const setup = (isolated = false) => {
  const keyring = memoryKeyring({ [`amo-cli:${ACCOUNT}`]: JSON.stringify(entry) })
  const storage = credentialStorage({
    credentials: {
      service: "amo-cli",
      configDir: folder(),
      storage: "keyring",
      keyring,
      ...(isolated ? { isolated } : {}),
    },
    account: ACCOUNT,
    codec: accountTokenCodec("amocrm"),
  })
  const keeper = tokenKeeper({
    provider: {
      id: "amocrm",
      name: "amoCRM",
      authorizeUrl: "http://127.0.0.1:9/authorize",
      tokenUrl: "http://127.0.0.1:9/token",
      client: { clientId: "owner-integration" },
      redirect: { kind: "loopback" },
    },
    storage,
    lockDir: folder(),
    fetch: (async () =>
      Response.json({
        access_token: "synthetic-access-new",
        refresh_token: "synthetic-refresh-2",
        expires_in: 3600,
      })) as typeof fetch,
    signInCommand: "amo work session start",
    now: () => NOW,
  })
  return { keyring, storage, keeper }
}

describe("accountTokenCodec", () => {
  it("reads the owner's secret, the account's host and the user beside the tokens", () => {
    expect(setup().storage.read()).toMatchObject({
      client: { clientId: "owner-integration", clientSecret: "synthetic-owner-secret" },
      account: { host: "https://example.amocrm.ru", userId: "7" },
      tokens: { refreshToken: "synthetic-refresh-1" },
    })
  })

  it("saves a rotated refresh token and keeps the secret, host and user", async () => {
    const { keyring, keeper } = setup()
    expect(await keeper.accessToken()).toBe("synthetic-access-new")
    expect(JSON.parse(keyring.get("amo-cli", ACCOUNT) ?? "")).toMatchObject({
      refreshToken: "synthetic-refresh-2",
      clientSecret: "synthetic-owner-secret",
      host: "https://example.amocrm.ru",
      userId: "7",
    })
  })

  it("a moved run's storage says so, so cli-base sends its writes to the temporary entry (RISK-2307)", () => {
    // cli-base reroutes a moved run's writes only for the system keyring, which no test may reach: what is checked
    // here is that the codec's storage reports the run as moved.
    expect(setup(true).storage.moved).toBe(true)
    expect(setup().storage.moved).toBe(false)
  })

  it("refuses an entry without its host, user or secret, and a sign-in that gives none", () => {
    const codec = accountTokenCodec("amocrm")
    const { host: _host, ...hostless } = entry
    expect(() => codec.decode(JSON.stringify(hostless))).toThrow(/sign in again/)
    expect(() =>
      codec.encode({
        tokens: { refreshToken: "synthetic-refresh", scopes: [] },
        client: { clientId: "owner-integration", clientSecret: "synthetic-owner-secret" },
      }),
    ).toThrow(/host and user/)
    expect(
      JSON.parse(
        codec.encode({
          tokens: { refreshToken: "synthetic-refresh", scopes: [] },
          client: { clientId: "owner-integration", clientSecret: "synthetic-owner-secret" },
          extra: { host: "https://example.amocrm.ru", userId: "7" },
        }),
      ),
    ).toMatchObject({ host: "https://example.amocrm.ru", userId: "7", clientSecret: "synthetic-owner-secret" })
  })

  it("a new sign-in takes its host and user from the sign-in alone, never from the entry it replaces (BUG-3)", () => {
    const codec = accountTokenCodec("amocrm")
    expect(codec.rotating).toBe(true)
    const signIn = {
      tokens: { refreshToken: "synthetic-refresh", scopes: [] },
      client: { clientId: "owner-integration", clientSecret: "synthetic-owner-secret" },
      previous: JSON.stringify(entry),
      signIn: true,
    }
    expect(() => codec.encode(signIn)).toThrow(/host and user/)
    expect(JSON.parse(codec.encode({ ...signIn, signIn: false }))).toMatchObject({ host: "https://example.amocrm.ru" })
  })
})
