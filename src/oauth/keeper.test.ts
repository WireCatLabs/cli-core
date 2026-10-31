import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { describe, expect, it } from "vitest"
import { acquireLock } from "../files/index.js"
import {
  authorize,
  credentialStorage,
  type OAuthProvider,
  oauthAccount,
  standardCodec,
  type TokenKeeperOptions,
  tokenKeeper,
} from "./index.js"

const NOW = 1_800_000_000_000
const folder = () => mkdtempSync(join(tmpdir(), "core-test-oauth-"))

const provider = (overrides: Partial<OAuthProvider> = {}): OAuthProvider => ({
  id: "example",
  name: "Example",
  authorizeUrl: "http://127.0.0.1:9/authorize",
  tokenUrl: "http://127.0.0.1:9/token",
  revokeUrl: "http://127.0.0.1:9/revoke",
  client: { clientId: "declared-client", clientSecret: "declared-public-secret" },
  redirect: { kind: "loopback" },
  authorizeParams: { access_type: "offline" },
  ...overrides,
})

interface Call {
  url: string
  body: URLSearchParams
}

const setup = (
  options: {
    saved?: Record<string, unknown>
    respond?: (call: Call) => Promise<Response> | Response
    isolated?: boolean
  } = {},
) => {
  const keyring = memoryKeyring(
    options.saved
      ? {
          "example-cli:oauth:example:personal": JSON.stringify({
            version: 1,
            provider: "example",
            clientId: "declared-client",
            scopes: ["s"],
            ...options.saved,
          }),
        }
      : {},
  )
  const calls: Call[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), body: new URLSearchParams(String(init?.body)) }
    calls.push(call)
    return options.respond
      ? options.respond(call)
      : Response.json({ access_token: "synthetic-access-new", expires_in: 3600 })
  }) as typeof globalThis.fetch
  const storage = credentialStorage({
    credentials: {
      service: "example-cli",
      configDir: folder(),
      storage: "keyring",
      keyring,
      ...(options.isolated ? { isolated: true } : {}),
    },
    account: oauthAccount("example", "personal"),
    codec: standardCodec("example"),
  })
  const records: Record<string, unknown>[] = []
  const log = {
    debug: (event: object) => records.push(event as Record<string, unknown>),
    info: (event: object) => records.push(event as Record<string, unknown>),
    warn: (event: object) => records.push(event as Record<string, unknown>),
    error: (event: object) => records.push(event as Record<string, unknown>),
  }
  const keeper = (overrides: Partial<TokenKeeperOptions> = {}) =>
    tokenKeeper({
      provider: provider(),
      storage,
      lockDir: folder(),
      fetch,
      signInCommand: "example personal session start",
      now: () => NOW,
      log,
      ...overrides,
    })
  return { keyring, calls, keeper, records, storage }
}

const stored = (keyring: ReturnType<typeof memoryKeyring>) =>
  JSON.parse(keyring.get("example-cli", "oauth:example:personal") ?? "null")

describe("tokens", () => {
  it("answers a fresh access token without a request", async () => {
    const { keeper, calls } = setup({
      saved: { accessToken: "synthetic-access", refreshToken: "r", expiresAt: NOW + 120_000 },
    })
    expect(await keeper().accessToken()).toBe("synthetic-access")
    expect(calls).toHaveLength(0)
  })

  it("refreshes once for concurrent callers in one process, keeping the refresh token and scopes", async () => {
    const { keeper, calls, keyring, records } = setup({
      saved: { accessToken: "old", refreshToken: "synthetic-refresh", expiresAt: NOW + 30_000 },
    })
    const one = keeper()
    const answers = await Promise.all([one.accessToken(), one.accessToken(), keeper().accessToken()])
    expect(answers).toEqual(["synthetic-access-new", "synthetic-access-new", "synthetic-access-new"])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body.get("client_secret")).toBe("declared-public-secret")
    expect(stored(keyring)).toMatchObject({
      refreshToken: "synthetic-refresh",
      scopes: ["s"],
      expiresAt: NOW + 3_600_000,
    })
    expect(JSON.stringify(records)).not.toContain("synthetic")
    expect(records).toContainEqual(
      expect.objectContaining({ operation: "refresh_token", outcome: "received", rotated: false }),
    )
  })

  it("says how to sign in when nothing is saved, and when the provider refuses the refresh", async () => {
    await expect(setup().keeper().tokens()).rejects.toMatchObject({
      code: "authentication_error",
      message: expect.stringContaining("example personal session start"),
    })
    const refused = setup({
      saved: { refreshToken: "synthetic-refresh-revoked" },
      respond: () => Response.json({ error: "invalid_grant", detail: "synthetic-refresh-revoked" }, { status: 400 }),
    })
    const error = await refused
      .keeper()
      .tokens()
      .catch((caught: Error) => caught)
    expect(error).toMatchObject({ code: "authentication_error", details: { status: 400 } })
    expect(JSON.stringify(error)).not.toContain("synthetic-refresh-revoked")
    expect((error as Error).message).not.toContain("synthetic-refresh-revoked")
  })

  it("tells a provider outage, a lost request and a malformed answer apart", async () => {
    const saved = { refreshToken: "r" }
    const answer = (respond: () => Response | Promise<Response>) => setup({ saved, respond }).keeper().tokens()
    await expect(answer(() => new Response("", { status: 503 }))).rejects.toMatchObject({
      code: "provider_unavailable",
    })
    await expect(answer(() => Promise.reject(new Error("socket")))).rejects.toMatchObject({ code: "outcome_unknown" })
    await expect(answer(() => new Response("not json"))).rejects.toMatchObject({ code: "invalid_response" })
    await expect(answer(() => Response.json({ access_token: "" }))).rejects.toMatchObject({ code: "invalid_response" })
    await expect(answer(() => Response.json({ access_token: "a", expires_in: -1 }))).rejects.toMatchObject({
      code: "invalid_response",
    })
  })

  it("uses a provider's own exchange", async () => {
    const { keeper, calls } = setup({ saved: { refreshToken: "r" } })
    const exchange: OAuthProvider["exchange"] = async (params, context) => ({
      accessToken: `own-${params.grant_type}`,
      refreshToken: context.previous?.refreshToken ?? "",
      expiresAt: context.now() + 1_000_000,
      scopes: [],
    })
    expect(await keeper({ provider: provider({ exchange }) }).accessToken()).toBe("own-refresh_token")
    expect(calls).toHaveLength(0)
  })

  it("waits for a lock another holder keeps, then gives up naming the retry", async () => {
    const { keeper, storage, records, calls } = setup({ saved: { refreshToken: "r" } })
    const lockDir = folder()
    const name = `oauth-${createHash("sha256").update(storage.key).digest("hex").slice(0, 16)}.lock`
    const lock = await acquireLock(join(lockDir, name))
    try {
      await expect(keeper({ lockDir, lockWaitMs: 20, lockRetryMs: 1 }).tokens()).rejects.toMatchObject({
        code: "provider_unavailable",
        details: { reason: "oauth.locked" },
      })
    } finally {
      await lock.release()
    }
    expect(calls).toHaveLength(0)
    expect(records).toContainEqual(expect.objectContaining({ operation: "lock", outcome: "waiting" }))
  })
})

describe("a run with moved folders", () => {
  const saved = { accessToken: "old", refreshToken: "synthetic-refresh", expiresAt: NOW - 1000 }

  it("keeps a refresh in memory for the rest of the process and leaves the keyring as it was", async () => {
    const { keeper, calls, keyring } = setup({ saved, isolated: true })
    const before = keyring.get("example-cli", "oauth:example:personal")
    const lockDir = folder()
    expect(await keeper({ lockDir }).accessToken()).toBe("synthetic-access-new")
    expect(await keeper({ lockDir }).accessToken()).toBe("synthetic-access-new")
    expect(calls).toHaveLength(1)
    expect(keyring.get("example-cli", "oauth:example:personal")).toBe(before)
  })

  it("still saves a refresh that rotated the refresh token", async () => {
    const { keeper, keyring } = setup({
      saved,
      isolated: true,
      respond: () =>
        Response.json({ access_token: "synthetic-access-new", refresh_token: "synthetic-refresh-2", expires_in: 60 }),
    })
    await keeper().accessToken()
    expect(stored(keyring)).toMatchObject({ refreshToken: "synthetic-refresh-2" })
  })
})

describe("signIn", () => {
  const visit = async (url: string, change: (query: URLSearchParams) => void) => {
    const authorization = new URL(url)
    const query = new URLSearchParams({ state: authorization.searchParams.get("state") ?? "", code: "synthetic-code" })
    change(query)
    const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "")
    callback.search = query.toString()
    return fetch(callback)
  }

  it("authorizes on the loopback, exchanges with PKCE and saves what accept adds", async () => {
    const { keeper, keyring, calls } = setup({
      respond: () => Response.json({ access_token: "a", refresh_token: "r", expires_in: 60, scope: "one two" }),
    })
    let shown = ""
    const statuses: number[] = []
    const result = await keeper().signIn({
      scopes: ["one", "two"],
      showUrl: (url) => {
        shown = url
      },
      openBrowser: async (url) => {
        statuses.push((await visit(url, (query) => query.set("state", "forged"))).status)
        statuses.push((await visit(url, () => {})).status)
      },
      accept: () => ({ account: "example-account" }),
    })
    expect(result).toEqual({ scopes: ["one", "two"] })
    expect(statuses).toEqual([400, 200])
    const url = new URL(shown)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      access_type: "offline",
      response_type: "code",
      client_id: "declared-client",
      scope: "one two",
      code_challenge_method: "S256",
    })
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(Object.fromEntries(calls[0]?.body ?? [])).toMatchObject({
      grant_type: "authorization_code",
      code: "synthetic-code",
      redirect_uri: url.searchParams.get("redirect_uri"),
      client_id: "declared-client",
    })
    expect(calls[0]?.body.get("code_verifier")).toMatch(/^[\w-]{64}$/)
    expect(stored(keyring)).toMatchObject({ account: "example-account", refreshToken: "r", scopes: ["one", "two"] })
  })

  it("saves a new sign-in in a run with moved folders", async () => {
    const { keeper, keyring } = setup({
      isolated: true,
      respond: () => Response.json({ access_token: "a", refresh_token: "r", expires_in: 60 }),
    })
    await keeper().signIn({ scopes: [], openBrowser: async (url) => void (await visit(url, () => {})) })
    expect(stored(keyring)).toMatchObject({ refreshToken: "r" })
  })

  it("saves nothing when accept refuses, or when no refresh token comes back", async () => {
    const { keeper, keyring } = setup({ respond: () => Response.json({ access_token: "a", expires_in: 60 }) })
    const openBrowser = async (url: string) => {
      await visit(url, () => {})
    }
    await expect(keeper().signIn({ scopes: [], openBrowser })).rejects.toMatchObject({ code: "authentication_error" })
    const other = setup({ respond: () => Response.json({ access_token: "a", refresh_token: "r" }) })
    await expect(
      other.keeper().signIn({
        scopes: [],
        openBrowser,
        accept: () => {
          throw new Error("another account")
        },
      }),
    ).rejects.toThrow("another account")
    expect(stored(keyring)).toBeNull()
    expect(stored(other.keyring)).toBeNull()
  })

  it("fails before the browser when the entry cannot be saved", async () => {
    const broken = {
      get: () => {
        throw new Error("no secret service")
      },
      set: () => {},
      delete: () => false,
    }
    const storage = credentialStorage({
      credentials: { service: "example-cli", configDir: folder(), storage: "keyring", keyring: broken },
      account: "a",
      codec: standardCodec("example"),
    })
    let opened = false
    const keeper = setup().keeper({ storage })
    await expect(
      keeper.signIn({
        scopes: [],
        openBrowser: async () => {
          opened = true
        },
      }),
    ).rejects.toMatchObject({ code: "configuration_error" })
    expect(opened).toBe(false)
  })
})

describe("authorize", () => {
  it("reports a declined consent", async () => {
    const declined = authorize({
      provider: provider(),
      scopes: [],
      openBrowser: async (url) => {
        const callback = new URL(new URL(url).searchParams.get("redirect_uri") ?? "")
        callback.search = new URLSearchParams({
          state: new URL(url).searchParams.get("state") ?? "",
          error: "access_denied",
        }).toString()
        await fetch(callback)
      },
    })
    await expect(declined).rejects.toMatchObject({
      code: "authentication_error",
      details: { reason: "oauth.declined" },
    })
  })

  it("takes a pasted result through a relay page, with the port in state", async () => {
    let state = ""
    const result = await authorize({
      provider: provider({ redirect: { kind: "relay", url: "https://relay.example/callback" } }),
      scopes: [],
      showUrl: (url) => {
        state = new URL(url).searchParams.get("state") ?? ""
      },
      openBrowser: () => Promise.reject(new Error("no browser")),
      readPaste: async () => `https://relay.example/callback?code=pasted-code&state=${state}`,
    })
    expect(state).toMatch(/^\d+\.[\w-]+$/)
    expect(result).toMatchObject({ code: "pasted-code", redirectUri: "https://relay.example/callback" })
  })

  it("refuses a pasted result for another sign-in, a timeout and a cancel", async () => {
    const base = { provider: provider(), scopes: [], openBrowser: async () => {} }
    await expect(authorize({ ...base, readPaste: async () => "code=x&state=other" })).rejects.toMatchObject({
      details: { reason: "oauth.mismatch" },
    })
    await expect(authorize({ ...base, timeoutMs: 5 })).rejects.toMatchObject({ code: "timeout" })
    const controller = new AbortController()
    const cancelled = authorize({ ...base, signal: controller.signal, showUrl: () => controller.abort() })
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" })
    await expect(authorize({ ...base, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "cancelled" })
  })
})

describe("signOut", () => {
  it("revokes the refresh token, then removes the entry", async () => {
    const { keeper, calls, keyring } = setup({
      saved: { refreshToken: "synthetic-refresh" },
      respond: () => new Response(""),
    })
    expect(await keeper().signOut({ revoke: true })).toEqual({ revoked: true, removed: ["keyring"] })
    expect(calls[0]?.url).toBe("http://127.0.0.1:9/revoke")
    expect(calls[0]?.body.get("token")).toBe("synthetic-refresh")
    expect(stored(keyring)).toBeNull()
  })

  it("keeps the entry when the revoke is not confirmed, and refuses without a way to revoke", async () => {
    const failing = setup({ saved: { refreshToken: "r" }, respond: () => new Response("", { status: 500 }) })
    await expect(failing.keeper().signOut({ revoke: true })).rejects.toMatchObject({ code: "outcome_unknown" })
    expect(stored(failing.keyring)).not.toBeNull()
    const none = setup({ saved: { refreshToken: "r" } })
    await expect(
      none.keeper({ provider: provider({ revokeUrl: undefined }) }).signOut({ revoke: true }),
    ).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(await none.keeper().signOut()).toEqual({ revoked: false, removed: ["keyring"] })
  })

  it("saves tokens a CLI got by its own flow", async () => {
    const { keeper, keyring } = setup()
    await keeper().save({ accessToken: "a", refreshToken: "own", scopes: [] })
    expect(stored(keyring)).toMatchObject({ refreshToken: "own", clientId: "declared-client" })
  })
})
