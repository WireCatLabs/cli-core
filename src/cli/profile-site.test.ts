import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { hostFetch } from "@wirecat/cli-base/http"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import type { Command } from "commander"
import type * as v from "valibot"
import { afterEach, expect, it } from "vitest"
import { baseContext } from "./context.js"
import { ProfileTokenStore } from "./profile-token.js"
import { run } from "./program.js"
import type { ServiceApiManifest } from "./service-api-manifest.js"
import { settingsFor } from "./settings.js"
import { serviceApiCommand } from "./shared-command-exports.js"
import { signedInSite, tokenSessionCommand } from "./token-session.js"

const app = { command: "blog", appName: "blog-cli", envPrefix: "BLOG", description: "synthetic", version: "1.0.0" }
const manifest: ServiceApiManifest = {
  servers: [{ url: "https://{site}/wp-json", variables: { site: { default: "example.com" } } }],
  securitySchemes: { basic: { type: "http", scheme: "bearer" } },
  security: [{ basic: [] }],
  operations: [
    {
      id: "listPosts",
      command: "list-posts",
      effect: "read",
      binding: { kind: "http", method: "GET", path: "/posts" },
      parameters: [],
    } as never,
  ],
}
// Each site knows only its own token, as two WordPress sites would.
const TOKENS: Record<string, string> = { "a.blog.test": "token-a", "b.blog.test/news": "token-b" }

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "profile-site-"))
  roots.push(root)
  const env = { HOME: root, BLOG_STATE_DIR: join(root, "state"), BLOG_CONFIG_DIR: join(root, "config") }
  const keyring = memoryKeyring()
  const sent: { url: string; authorization: string | null }[] = []
  const configuration = settingsFor(app)
  const site = signedInSite(app, configuration.resolveSettings)
  const answer = async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    const authorization = new Headers(init?.headers).get("authorization")
    sent.push({ url: url.href, authorization })
    const at = `${url.host}${url.pathname.replace(/\/wp-json\/.*$/, "")}`
    if (authorization !== `Bearer ${TOKENS[at]}`) return new Response("{}", { status: 401 })
    return Response.json(url.pathname.endsWith("/users/me") ? { id: `me@${at}` } : [{ id: 1, site: at }])
  }
  const fetchFor = (host: string) => hostFetch({ hosts: [host], fetch: answer as typeof fetch })
  const tokenOf = (command: Command) => {
    const { env: at, keyring: ring, settings } = baseContext(command, configuration.resolveSettings)
    return new ProfileTokenStore({ app, env: at, ...(ring ? { keyring: ring } : {}) }).need(settings.profile)
  }
  const definition = {
    app,
    configuration,
    commands: () => [
      tokenSessionCommand({
        app,
        service: "Blog",
        resolveSettings: configuration.resolveSettings,
        site: { example: "blog.example.com" },
        verify: async (_command, token, _events, at) => {
          const host = (at ?? "").split("/")[0] as string
          const response = await fetchFor(host)(`https://${at}/wp-json/users/me`, {
            headers: { authorization: `Bearer ${token}` },
          })
          if (!response.ok) throw new CliError("authentication_error", "Blog refused the token")
          const { id } = (await response.json()) as { id: string }
          return { id, account: { id } }
        },
      }),
      serviceApiCommand({
        app,
        configuration,
        manifest,
        service: "Blog",
        serverVariables: site,
        fetch: (command) => fetchFor(site(command).site.split("/")[0] as string),
        token: tokenOf,
        schemas: async () => ({}) as Record<string, v.GenericSchema>,
        definitions: async () => ({}),
      }),
    ],
  }
  const cli = async (argv: string[], stdin?: string) => {
    const streams = captureStreams()
    const { Readable } = await import("node:stream")
    const code = await run(argv, definition, {
      streams,
      env,
      keyring,
      tty: false,
      ...(stdin === undefined ? {} : { stdin: Readable.from([stdin]) }),
    })
    const out = streams.stdout.join("")
    const err = streams.stderr.join("")
    return {
      code,
      json: out.startsWith("{") ? JSON.parse(out) : undefined,
      error: err.startsWith("{") ? JSON.parse(err).error : undefined,
    }
  }
  return { cli, sent }
}

it("one CLI reads two sites through two profiles, each token only at its own site", async () => {
  const { cli, sent } = setup()
  expect((await cli(["one", "api", "list", "--json"])).code).toBe(0)
  const before = await cli(["one", "api", "list-posts", "--json"])
  expect(before.error.message).toContain("one has no site yet: blog one session start --site <address>")

  const a = await cli(["one", "session", "start", "--site", "https://a.blog.test/", "--json"], "token-a\n")
  expect(a.json.item).toMatchObject({ site: "a.blog.test", verified: true })
  const b = await cli(["two", "session", "start", "--site", "b.blog.test/news", "--json"], "token-b\n")
  expect(b.json.item).toMatchObject({ site: "b.blog.test/news", verified: true })
  expect((await cli(["two", "session", "status", "--json"])).json.item).toMatchObject({ site: "b.blog.test/news" })

  sent.length = 0
  expect((await cli(["one", "api", "list-posts", "--json"])).json.item).toEqual([{ id: 1, site: "a.blog.test" }])
  expect((await cli(["two", "api", "list-posts", "--json"])).json.item).toEqual([{ id: 1, site: "b.blog.test/news" }])
  expect(sent).toEqual([
    { url: "https://a.blog.test/wp-json/posts", authorization: "Bearer token-a" },
    { url: "https://b.blog.test/news/wp-json/posts", authorization: "Bearer token-b" },
  ])
})

it("session start refuses a missing, plain-http or credential-bearing site before asking anything", async () => {
  const { cli, sent } = setup()
  for (const args of [
    [],
    ["--site", "http://a.blog.test"],
    ["--site", "me:pw@a.blog.test"],
    ["--site", "a.blog.test?x=1"],
  ]) {
    const refused = await cli(["one", "session", "start", ...args, "--json"], "token-a\n")
    expect(refused.error).toMatchObject({ code: "validation_error" })
  }
  expect(sent).toEqual([])
})
