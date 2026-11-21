import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { accountFileFor } from "./messenger/accounts.js"
import { run } from "./program.js"
import { hostsFetch } from "./service-api-call.js"
import type { ServiceApiManifest } from "./service-api-manifest.js"
import { settingsFor } from "./settings.js"
import { manifestVerify, type TokenSessionOptions, tokenSessionCommand } from "./token-session.js"

const app = { command: "pages", appName: "pages-cli", envPrefix: "PAGES", description: "synthetic", version: "1.0.0" }
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "token-session-"))
  roots.push(root)
  mkdirSync(join(root, "config"), { recursive: true })
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "xdg"),
    PAGES_STATE_DIR: join(root, "state"),
    PAGES_CONFIG_DIR: join(root, "config"),
    PAGES_CACHE_DIR: join(root, "cache"),
  }
  const keyring = memoryKeyring()
  const checked: string[] = []
  const cli = async (argv: string[], stdin?: string, claim?: TokenSessionOptions["claim"]) => {
    const streams = captureStreams()
    const code = await run(
      argv,
      {
        app,
        commands: () => [
          tokenSessionCommand({
            app,
            service: "Pages",
            resolveSettings: settingsFor(app).resolveSettings,
            ...(claim ? { claim } : {}),
            verify: async (_command, token) => {
              checked.push(token)
              if (token !== "good-token") throw new CliError("authentication_error", "Pages refused the token")
              return { id: "workspace-1", account: { user: { id: "u1", name: "Synthetic" } } }
            },
          }),
        ],
      },
      { streams, tty: false, env, keyring, ...(stdin === undefined ? {} : { stdin: Readable.from([stdin]) }) },
    )
    const out = streams.stdout.join("")
    const err = streams.stderr.join("")
    return {
      code,
      json: out ? JSON.parse(out) : undefined,
      error: err.startsWith("{") ? JSON.parse(err).error : undefined,
    }
  }
  return { env, cli, checked }
}

it("session start checks the token before keeping it; status, list and end", async () => {
  const { env, cli, checked } = setup()
  const started = await cli(["personal", "session", "start", "--json"], "good-token\n")
  expect(started.json.item).toMatchObject({ profile: "personal", state: "saved", verified: true, user: { id: "u1" } })
  expect(JSON.stringify(started.json)).not.toContain("good-token")
  expect(JSON.parse(readFileSync(accountFileFor(app, "personal", env), "utf8"))).toEqual({ account: "workspace-1" })

  expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({
    state: "saved",
    verified: false,
  })
  const status = await cli(["personal", "session", "status", "--check", "--json"])
  expect(status.json.item).toMatchObject({ state: "saved", verified: true, user: { name: "Synthetic" } })
  expect(checked).toEqual(["good-token", "good-token"])

  expect((await cli(["session", "list", "--json"])).json.items).toContainEqual(
    expect.objectContaining({ profile: "personal", signed_in: true }),
  )
  expect((await cli(["personal", "session", "end", "--json"])).code).toBe(0)
  expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({ state: "missing" })
})

it("session start keeps nothing when the service refuses the token, or when none is given", async () => {
  const { cli } = setup()
  const refused = await cli(["personal", "session", "start", "--json"], "wrong-token\n")
  expect(refused.error).toMatchObject({ code: "authentication_error" })
  expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({ state: "missing" })
  const empty = await cli(["personal", "session", "start", "--json"], "\n")
  expect(empty.error).toMatchObject({ code: "validation_error" })
  const storage = await cli(["personal", "session", "start", "--credential-storage", "vault", "--json"], "good-token\n")
  expect(storage.error).toMatchObject({ code: "validation_error" })
})

it("session start refuses --offline and a taken account before keeping anything", async () => {
  const { cli, checked } = setup()
  const offline = await cli(["--offline", "personal", "session", "start", "--json"], "good-token\n")
  expect(offline.error).toMatchObject({ code: "permission_error" })
  expect(checked).toEqual([])
  const taken = await cli(["work", "session", "start", "--json"], "good-token\n", () => {
    throw new CliError("conflict", "profile personal already uses this account")
  })
  expect(taken.error).toMatchObject({ code: "conflict" })
  expect((await cli(["work", "session", "status", "--json"])).json.item).toMatchObject({ state: "missing" })
})

it("session status --check checks a token from the environment variable, and never prints it", async () => {
  const { env, cli, checked } = setup()
  env.PAGES_TOKEN = "good-token"
  const status = await cli(["personal", "session", "status", "--check", "--json"])
  expect(status.json.item).toMatchObject({ state: "saved", token_from: "environment", verified: true })
  expect(checked).toEqual(["good-token"])
  expect(JSON.stringify(status.json)).not.toContain("good-token")
})

describe("manifestVerify", () => {
  const manifest = {
    servers: [{ url: "https://api.acme.test/v1" }],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
    operations: [
      { id: "getSelf", command: "get-self", effect: "read", binding: { kind: "http", method: "GET", path: "/self" } },
    ],
  } as unknown as ServiceApiManifest
  const verifying = (answer: unknown, verify: Parameters<typeof manifestVerify>[0]["verify"]) => {
    const sent: { url: string; authorization: string | null }[] = []
    const fake = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      sent.push({ url: request.url, authorization: request.headers.get("authorization") })
      return Response.json(answer)
    }
    const check = manifestVerify({
      manifest,
      service: "Acme",
      verify,
      fetch: () => hostsFetch(["api.acme.test"], fake),
    })
    return { sent, check: () => check(new Command("start"), "tok-1", () => undefined, undefined) }
  }

  it("sends the one operation with the token and keeps the id and name the answer holds", async () => {
    const { sent, check } = verifying(
      { data: { workspace: 42, title: "Acme Inc" }, active: true },
      { operation: "getSelf", id: "data.workspace", name: "data.title", active: "active" },
    )
    expect(await check()).toEqual({ id: "42", account: { id: "42", name: "Acme Inc" } })
    expect(sent).toEqual([{ url: "https://api.acme.test/v1/self", authorization: "Bearer tok-1" }])
  })

  it("leaves out a name that is not text, and asks nothing about activity when the config names no field", async () => {
    const { check } = verifying({ id: "w1", name: { first: "A" } }, { operation: "getSelf", id: "id", name: "name" })
    expect(await check()).toEqual({ id: "w1", account: { id: "w1" } })
    expect(await verifying({ id: "w2" }, { operation: "getSelf", id: "id" }).check()).toEqual({
      id: "w2",
      account: { id: "w2" },
    })
  })

  it("refuses a token the answer does not call active, as Attio answers a revoked key with 200", async () => {
    for (const active of [false, null, "yes"])
      await expect(
        verifying({ id: "w1", active }, { operation: "getSelf", id: "id", active: "active" }).check(),
      ).rejects.toMatchObject({ code: "authentication_error" })
  })

  it("checks a password on the site session start names, by Basic, and on no other", async () => {
    const sent: { url: string; authorization: string | null }[] = []
    const fake = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      sent.push({ url: request.url, authorization: request.headers.get("authorization") })
      return Response.json({ id: 7, name: "editor" })
    }
    const check = manifestVerify({
      manifest: {
        servers: [{ url: "https://{site}/wp-json", variables: { site: {} } }],
        securitySchemes: { applicationPassword: { type: "http", scheme: "basic" } },
        security: [{ applicationPassword: [] }],
        operations: [
          {
            id: "me",
            command: "me",
            effect: "read",
            binding: { kind: "http", method: "GET", path: "/wp/v2/users/me" },
          },
        ],
      } as unknown as ServiceApiManifest,
      service: "WordPress",
      verify: { operation: "me", id: "id", name: "name" },
      fetch: (_command, site) => hostsFetch([new URL(`https://${site}`).hostname], fake, `https://${site}/wp-json`),
    })
    expect(await check(new Command("start"), "editor:abcd efgh", () => undefined, "host.test/blog")).toEqual({
      id: "7",
      account: { id: "7", name: "editor" },
    })
    expect(sent).toEqual([
      {
        url: "https://host.test/blog/wp-json/wp/v2/users/me",
        authorization: `Basic ${Buffer.from("editor:abcd efgh").toString("base64")}`,
      },
    ])
  })

  it("is the service's error when the answer holds no id", async () => {
    await expect(verifying({ id: null }, { operation: "getSelf", id: "id" }).check()).rejects.toMatchObject({
      code: "provider_error",
      details: { reason: "verify.no-id" },
    })
  })
})

it("hostsFetch reaches only its hosts, over the network when no fetch is given", async () => {
  await expect(hostsFetch(["api.acme.test"], undefined)("https://elsewhere.test/x")).rejects.toThrow(/elsewhere\.test/)
  const fake = async () => new Response("ok")
  expect(await (await hostsFetch(["api.acme.test"], fake)("https://api.acme.test/x")).text()).toBe("ok")
})

it("names the sign-in it keeps in the group's help", () => {
  const session = (extra: Partial<TokenSessionOptions>) =>
    tokenSessionCommand({
      app,
      service: "Pages",
      resolveSettings: settingsFor(app).resolveSettings,
      verify: async () => ({ id: "w", account: {} }),
      ...extra,
    }).description()
  expect(session({})).toBe("keep this profile's Pages API token in the OS keyring")
  expect(session({ login: { page: () => "https://example.com" } })).toBe(
    "keep this profile's Pages password in the OS keyring",
  )
  expect(session({ token: "application password" })).toBe(
    "keep this profile's Pages application password in the OS keyring",
  )
})
