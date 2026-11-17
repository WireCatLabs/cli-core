import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams, type KeyringStore } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import type { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { oauthFlowOf, oauthPreset, oauthSessionCommand } from "./oauth-session.js"
import { run } from "./program.js"
import type { ServiceApiManifest } from "./service-api-manifest.js"
import { settingsFor } from "./settings.js"

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

const roots: string[] = []
afterEach(() => {
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

const setup = (keyring: KeyringStore = memoryKeyring()) => {
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
          }),
        ],
      },
      {
        streams,
        tty: false,
        env,
        keyring,
        fetch: service,
        openBrowser: async (url: string, _command?: Command) => void (await visit(url)),
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
  return { cli, keyring, tokenCalls, verified }
}

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
