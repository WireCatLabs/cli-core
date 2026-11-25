import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { CliError, captureStreams, type KeyringStore } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { type Command, Option } from "commander"
import { afterEach, describe, expect, it, vi } from "vitest"
import { driveSessionCodec, zoomTokenCodec } from "../oauth/storage.js"
import { type OAuthSessionOptions, type OAuthSignedIn, oauthFlowOf, oauthPreset } from "./oauth-session.js"
import { run } from "./program.js"
import type { ServiceApiManifest } from "./service-api-manifest.js"
import { settingsFor } from "./settings.js"
import { oauthSessionCommand } from "./shared-command-exports.js"
import { assertSharedContracts, hasSharedContract } from "./shared-contracts.js"

const app = { command: "crm", appName: "crm-cli", envPrefix: "CRM", description: "synthetic", version: "1.0.0" }
const manifest: ServiceApiManifest = {
  operations: [],
  securitySchemes: {
    oauth2: {
      type: "oauth2",
      flows: {
        authorizationCode: {
          authorizationUrl: "https://app.crm.test/authorize",
          tokenUrl: "https://app.crm.test/oauth/token",
          scopes: { "record_permission:read": "View records.", "user_management:read": "View members." },
        },
      },
    },
  },
}
const OWNER_ENTRY = "crm-cli:oauth:crm:personal"

// Every test folder is a moved run; the owner's own run, which copies an old entry, is only reached this way.
const owner = vi.hoisted(() => ({ run: false }))
vi.mock("@wirecat/cli-base", async (original) => {
  const base = await original<typeof import("@wirecat/cli-base")>()
  return {
    ...base,
    isMovedRun: (options: Parameters<typeof base.isMovedRun>[0]) => !owner.run && base.isMovedRun(options),
  }
})

const roots: string[] = []
afterEach(() => {
  owner.run = false
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The browser's part: back to the loopback with the state the sign-in sent, as the provider would redirect. */
const visit = (url: string) => {
  const authorization = new URL(url)
  const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "")
  callback.search = new URLSearchParams({
    state: authorization.searchParams.get("state") ?? "",
    code: "synthetic-code",
  }).toString()
  return fetch(callback)
}

const callbackOf = (url: string) => {
  const authorization = new URL(url)
  const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "")
  callback.search = new URLSearchParams({ state: authorization.searchParams.get("state") ?? "", code: "c" }).toString()
  return callback.toString()
}

const setup = (
  keyring: KeyringStore = memoryKeyring(),
  more: Partial<OAuthSessionOptions> = {},
  browser: (url: string) => Promise<unknown> = visit,
) => {
  const root = mkdtempSync(join(tmpdir(), "oauth-session-"))
  roots.push(root)
  mkdirSync(join(root, "config"), { recursive: true })
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "xdg"),
    CRM_STATE_DIR: join(root, "state"),
    CRM_CONFIG_DIR: join(root, "config"),
    CRM_CACHE_DIR: join(root, "cache"),
  }
  const tokenCalls: URLSearchParams[] = []
  const verified: string[] = []
  const opened: string[] = []
  const stdin = new PassThrough()
  const service = (async (_url: string | URL | Request, init?: RequestInit) => {
    tokenCalls.push(new URLSearchParams(String(init?.body)))
    return Response.json({
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      expires_in: 3600,
      scope: "record_permission:read",
    })
  }) as typeof fetch
  const cli = async (argv: string[], verify?: () => never) => {
    const streams = captureStreams()
    const code = await run(
      argv,
      {
        app,
        commands: () => [
          oauthSessionCommand({
            app,
            resolveSettings: settingsFor(app).resolveSettings,
            providerId: "crm",
            service: "Crm",
            preset: () =>
              oauthPreset(oauthFlowOf(manifest), {
                id: "crm",
                name: "Crm",
                client: { clientId: "synthetic-client", clientSecret: "synthetic-client-secret" },
                scopes: ["record_permission:read"],
                redirect: { kind: "loopback" },
              }),
            verify: async (_command, accessToken) => {
              verified.push(accessToken)
              verify?.()
              return { id: "workspace-1", account: { workspace: "Synthetic" } }
            },
            ...more,
          }),
        ],
      },
      {
        streams,
        tty: false,
        env,
        keyring,
        fetch: service,
        stdin,
        openBrowser: async (url: string, _command?: Command) => {
          opened.push(url)
          await browser(url)
        },
      } as never,
    )
    const out = streams.stdout.join("")
    const err = streams.stderr.join("")
    return {
      code,
      json: out ? JSON.parse(out) : undefined,
      err,
      error: err
        .split("\n")
        .filter((line) => line.startsWith('{"error"'))
        .map((line) => JSON.parse(line).error)[0],
    }
  }
  return { cli, keyring, tokenCalls, verified, opened, stdin }
}

const zmEntry = JSON.stringify({
  accessToken: "synthetic-access-old",
  refreshToken: "synthetic-refresh-old",
  expiresAt: Date.UTC(2030, 0, 1),
  scopes: ["record_permission:read"],
})
const OLD_SERVICE = "crm-cli:/old/config"
const legacyAccounts = (_env: NodeJS.ProcessEnv, profile: string) => [
  { service: OLD_SERVICE, account: `c1:${profile}` },
]

describe("oauthFlowOf and oauthPreset", () => {
  it("reads the authorization code flow and checks each scope the CLI asks for", () => {
    const flow = oauthFlowOf(manifest)
    expect(flow.tokenUrl).toBe("https://app.crm.test/oauth/token")
    const options = { id: "crm", name: "Crm", client: { clientId: "c" }, redirect: { kind: "loopback" as const } }
    expect(oauthPreset(flow, { ...options, scopes: ["record_permission:read"] }).provider).toMatchObject({
      authorizeUrl: "https://app.crm.test/authorize",
      tokenUrl: "https://app.crm.test/oauth/token",
    })
    expect(() => oauthPreset(flow, { ...options, scopes: ["record_permision:read"] })).toThrow(
      "did you mean record_permission:read?",
    )
    expect(() => oauthFlowOf({ operations: [] })).toThrow("no OAuth authorization code flow")
    const authorizationCode = manifest.securitySchemes?.oauth2?.flows?.authorizationCode as NonNullable<
      NonNullable<NonNullable<ServiceApiManifest["securitySchemes"]>[string]["flows"]>["authorizationCode"]
    >
    const twice: ServiceApiManifest = {
      operations: [],
      securitySchemes: {
        one: { type: "oauth2", flows: { authorizationCode } },
        two: { type: "oauth2", flows: { authorizationCode } },
        machine: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://app.crm.test/t", scopes: {} } } },
      },
    }
    expect(() => oauthFlowOf(twice)).toThrow("2 OAuth sign-ins in the browser; name one")
    expect(oauthFlowOf(twice, "two").authorizationUrl).toBe("https://app.crm.test/authorize")
    const scopes = ["record_permission:read"]
    expect(() => oauthPreset({ ...flow, tokenUrl: "http://app.crm.test/token" }, { ...options, scopes })).toThrow(
      "not https",
    )
    expect(() => oauthPreset({ ...flow, refreshUrl: "https://app.crm.test/refresh" }, { ...options, scopes })).toThrow(
      "refreshes at another URL",
    )
  })
})

describe("oauthSessionCommand", () => {
  it("signs in with PKCE, checks the account first, then status, list and end", async () => {
    const { cli, tokenCalls, verified } = setup()
    const started = await cli(["personal", "session", "start", "--json"])
    expect(started.error).toBeUndefined()
    expect(started.json.item).toMatchObject({ profile: "personal", signed_in: true, workspace: "Synthetic" })
    expect(tokenCalls[0]?.get("code_verifier")).toMatch(/^[\w-]{43,}$/)
    expect(tokenCalls[0]?.get("client_secret")).toBe("synthetic-client-secret")
    expect(`${started.err}${JSON.stringify(started.json)}`).not.toMatch(/synthetic-(access|refresh|client-secret|code)/)

    expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({
      state: "saved",
      scopes: ["record_permission:read"],
      verified: false,
    })
    const checked = await cli(["personal", "session", "status", "--check", "--json"])
    expect(checked.json.item).toMatchObject({ verified: true, workspace: "Synthetic" })
    expect(verified).toEqual(["synthetic-access", "synthetic-access"])
    expect((await cli(["session", "list", "--json"])).json.items).toContainEqual({
      profile: "personal",
      signed_in: true,
      state: "saved",
    })

    expect((await cli(["personal", "session", "end", "--json"])).json.item).toMatchObject({ ended: true })
    expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({ state: "missing" })
  })

  it("keeps the sign-in as it was when another account is refused", async () => {
    const { cli } = setup()
    expect((await cli(["personal", "session", "start", "--json"])).code).toBe(0)
    const refused = await cli(["personal", "session", "start", "--json"], () => {
      throw new CliError("conflict", "this account is another profile's")
    })
    expect(refused.error).toMatchObject({ code: "conflict" })
    expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({ state: "saved" })
  })

  it("--credential-storage file forgets an older keyring copy", async () => {
    const { cli, keyring } = setup()
    expect((await cli(["personal", "session", "start", "--json"])).code).toBe(0)
    expect(keyring.get("crm-cli", "oauth:crm:personal")).not.toBeNull()
    expect((await cli(["personal", "session", "start", "--credential-storage", "file", "--json"])).code).toBe(0)
    expect(keyring.get("crm-cli", "oauth:crm:personal")).toBeNull()
    expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({ state: "saved" })
  })

  it("keeps nothing when the account is refused", async () => {
    const { cli } = setup()
    const refused = await cli(["personal", "session", "start", "--json"], () => {
      throw new CliError("conflict", "this account is another profile's")
    })
    expect(refused.error).toMatchObject({ code: "conflict" })
    expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({ state: "missing" })
  })

  it("says the profile is still signed in when the owner's entry stays, as in a run with moved folders", async () => {
    const owner = JSON.stringify({
      version: 1,
      provider: "crm",
      clientId: "synthetic-client",
      refreshToken: "owner-refresh",
      scopes: ["record_permission:read"],
    })
    // cli-base keeps the owner's entry only for the system keyring, which no test reaches: this one keeps it the same way.
    const memory = memoryKeyring({ [OWNER_ENTRY]: owner })
    const keyring: KeyringStore = {
      get: (service, account) => memory.get(service, account),
      set: (service, account, secret) => memory.set(service, account, secret),
      delete: () => false,
    }
    const { cli } = setup(keyring)
    const ended = await cli(["personal", "session", "end", "--json"])
    expect(ended.json.item).toMatchObject({ ended: false })
    expect(ended.json.item.why).toContain("moved folders")
    expect(memory.get("crm-cli", "oauth:crm:personal")).toBe(owner)
  })
})

describe("oauthSessionCommand for a CLI that kept its own sign-ins", () => {
  it("reads an entry in the CLI's own format, with the access token's end", async () => {
    const { cli } = setup(memoryKeyring({ [OWNER_ENTRY]: zmEntry }), { codec: zoomTokenCodec })
    expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({
      state: "saved",
      scopes: ["record_permission:read"],
      expires_at: "2030-01-01T00:00:00.000Z",
    })
  })

  it("copies an older entry under another service to the profile's own, and session end removes both", async () => {
    owner.run = true
    const keyring = memoryKeyring({ [`${OLD_SERVICE}:c1:personal`]: zmEntry })
    const { cli } = setup(keyring, { codec: zoomTokenCodec, legacyAccounts })
    expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({ state: "saved" })
    expect(keyring.get("crm-cli", "oauth:crm:personal")).toBe(zmEntry)
    expect(keyring.get(OLD_SERVICE, "c1:personal")).toBe(zmEntry)

    expect((await cli(["personal", "session", "end", "--json"])).json.item).toMatchObject({ ended: true })
    expect(keyring.get("crm-cli", "oauth:crm:personal")).toBeNull()
    expect(keyring.get(OLD_SERVICE, "c1:personal")).toBeNull()
    expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({ state: "missing" })
  })

  it("in a run with moved folders reads the older entry but never copies or removes it", async () => {
    const keyring = memoryKeyring({ [`${OLD_SERVICE}:c1:personal`]: zmEntry })
    const { cli } = setup(keyring, { codec: zoomTokenCodec, legacyAccounts })
    expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({ state: "saved" })
    expect(keyring.get("crm-cli", "oauth:crm:personal")).toBeNull()
    const ended = await cli(["personal", "session", "end", "--json"])
    expect(ended.json.item).toMatchObject({ ended: false })
    expect(ended.json.item.why).toContain("moved folders")
    expect(keyring.get(OLD_SERVICE, "c1:personal")).toBe(zmEntry)
  })

  it("passes a start option to the preset, saves verify's extra and hands the client to afterSignIn", async () => {
    const after: OAuthSignedIn[] = []
    const { cli, keyring, opened } = setup(memoryKeyring(), {
      codec: driveSessionCodec,
      startOptions: [new Option("--grant <scopes>", "more to ask")],
      preset: (command) =>
        oauthPreset(oauthFlowOf(manifest), {
          id: "crm",
          name: "Crm",
          client: { clientId: "own-client" },
          scopes: [
            "record_permission:read",
            ...(command.opts<{ grant?: string }>().grant === "members" ? ["user_management:read"] : []),
          ],
          redirect: { kind: "loopback" },
        }),
      verify: async () => ({
        id: "member-1",
        account: { member: "Synthetic" },
        extra: { principal: "synthetic-principal" },
      }),
      afterSignIn: (_command, signedIn) => void after.push(signedIn),
    })
    const started = await cli(["personal", "session", "start", "--grant", "members", "--json"])
    expect(started.error).toBeUndefined()
    expect(new URL(opened[0] ?? "").searchParams.get("scope")).toBe("record_permission:read user_management:read")
    expect(JSON.parse(keyring.get("crm-cli", "oauth:crm:personal") ?? "")).toMatchObject({
      principal: "synthetic-principal",
      clientId: "own-client",
    })
    expect(after).toEqual([
      expect.objectContaining({
        profile: "personal",
        id: "member-1",
        account: { member: "Synthetic" },
        client: { clientId: "own-client" },
      }),
    ])
  })

  it("with --answer-stdin lets the preset ask for the client and reads the pasted redirect", async () => {
    const after: OAuthSignedIn[] = []
    let feed = (_line: string) => {}
    const { cli, tokenCalls, stdin } = setup(
      memoryKeyring(),
      {
        preset: async (_command, steps) => {
          const clientId = steps?.answers
            ? await steps.ask({ field: "client_id", secret: false, prompt: "client" })
            : ""
          return oauthPreset(oauthFlowOf(manifest), {
            id: "crm",
            name: "Crm",
            client: { clientId },
            scopes: ["record_permission:read"],
            redirect: { kind: "loopback" },
          })
        },
        afterSignIn: (_command, signedIn) => void after.push(signedIn),
      },
      async (url) => feed(`${callbackOf(url)}\n`),
    )
    feed = (line) => stdin.write(line)
    stdin.write("asked-client\n")
    const started = await cli(["personal", "session", "start", "--json", "--answer-stdin"])
    expect(started.error).toBeUndefined()
    expect(started.err).toContain('"field":"redirect"')
    expect(tokenCalls[0]?.get("client_id")).toBe("asked-client")
    expect(after[0]?.client.clientId).toBe("asked-client")
  })

  it("lists every profile when the keyring cannot be reached, and takes the CLI's own profiles", async () => {
    const keyring: KeyringStore = {
      get: () => {
        throw new Error("synthetic: no secret service")
      },
      set: () => {},
      delete: () => false,
    }
    const { cli } = setup(keyring, { profiles: () => ["personal", "work"] })
    const listed = await cli(["session", "list", "--json"])
    expect(listed.code).toBe(0)
    expect(listed.json.items).toEqual([
      { profile: "personal", signed_in: null, state: "unknown" },
      { profile: "work", signed_in: null, state: "unknown" },
    ])
  })
})

it("is cli-core's own session group, which a CLI changes only through its options", () => {
  const session = oauthSessionCommand({
    app,
    resolveSettings: settingsFor(app).resolveSettings,
    providerId: "crm",
    service: "Crm",
    startOptions: [new Option("--grant <scopes>", "more to ask")],
    preset: () => {
      throw new Error("not reached")
    },
    verify: async () => ({ id: "w", account: {} }),
  })
  const start = session.commands.find((command) => command.name() === "start") as Command
  expect(hasSharedContract(session) && hasSharedContract(start)).toBe(true)
  expect(() => assertSharedContracts(session)).not.toThrow()
  start.option("--later <value>", "added after the factory")
  expect(() => assertSharedContracts(session)).toThrow("shared contract changed")
})
