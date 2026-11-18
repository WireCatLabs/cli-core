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

const setup = (extra: Record<string, string> = {}, basic = false) => {
  // With basic, a site knows `editor:<its token>`, as WordPress knows a user's application password.
  const header = (token: string) => (basic ? `Basic ${Buffer.from(token).toString("base64")}` : `Bearer ${token}`)
  const expected = (at: string) => header(basic ? `editor:${TOKENS[at]}` : (TOKENS[at] as string))
  const root = mkdtempSync(join(tmpdir(), "profile-site-"))
  roots.push(root)
  const env = { HOME: root, BLOG_STATE_DIR: join(root, "state"), BLOG_CONFIG_DIR: join(root, "config"), ...extra }
  const keyring = memoryKeyring()
  const sent: { url: string; authorization: string | null }[] = []
  const configuration = settingsFor(app)
  const site = signedInSite(app, configuration.resolveSettings)
  const answer = async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    const authorization = new Headers(init?.headers).get("authorization")
    sent.push({ url: url.href, authorization })
    const at = `${url.host}${url.pathname.replace(/\/wp-json\/.*$/, "")}`
    if (authorization !== expected(at)) return new Response("{}", { status: 401 })
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
        ...(basic
          ? { login: { page: (at: string | undefined) => `https://${at}/wp-admin/authorize-application.php` } }
          : {}),
        verify: async (_command, token, _events, at) => {
          const host = (at ?? "").split("/")[0] as string
          const response = await fetchFor(host)(`https://${at}/wp-json/users/me`, {
            headers: { authorization: header(token) },
          })
          if (!response.ok) throw new CliError("authentication_error", "Blog refused the token")
          const { id } = (await response.json()) as { id: string }
          return { id, account: { id } }
        },
      }),
      serviceApiCommand({
        app,
        configuration,
        manifest: basic ? { ...manifest, securitySchemes: { basic: { type: "http", scheme: "basic" } } } : manifest,
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
      err,
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
  expect(before.error.message).toContain(
    "one is not signed in to a site — run `blog one session start --site <address>`",
  )

  const a = await cli(["one", "session", "start", "--site", "https://a.blog.test/", "--json"], "token-a\n")
  expect(a.json.item).toMatchObject({ site: "a.blog.test", verified: true })
  const b = await cli(["two", "session", "start", "--site", "b.blog.test/news", "--json"], "token-b\n")
  expect(b.json.item).toMatchObject({ site: "b.blog.test/news", verified: true })
  expect((await cli(["two", "session", "status", "--json"])).json.item).toMatchObject({ site: "b.blog.test/news" })

  expect(sent.map(({ url, authorization }) => `${url} ${authorization}`)).toEqual([
    "https://a.blog.test/wp-json/users/me Bearer token-a",
    "https://b.blog.test/news/wp-json/users/me Bearer token-b",
  ])
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

it("a site goes with its token: end forgets both, a failed sign-in keeps the old pair, a new one moves both", async () => {
  const { cli, sent } = setup()
  await cli(["one", "session", "start", "--site", "a.blog.test", "--json"], "token-a\n")
  const refused = await cli(["one", "session", "start", "--site", "b.blog.test/news", "--json"], "token-a\n")
  expect(refused.error).toMatchObject({ code: "authentication_error" })
  expect((await cli(["one", "session", "status", "--json"])).json.item).toMatchObject({ site: "a.blog.test" })
  await cli(["one", "session", "start", "--site", "b.blog.test/news", "--json"], "token-b\n")
  sent.length = 0
  await cli(["one", "api", "list-posts", "--json"])
  expect(sent).toEqual([{ url: "https://b.blog.test/news/wp-json/posts", authorization: "Bearer token-b" }])
  await cli(["one", "session", "end", "--json"])
  sent.length = 0
  expect((await cli(["one", "api", "list-posts", "--json"])).error).toMatchObject({ code: "authentication_error" })
  expect((await cli(["one", "session", "status", "--json"])).json.item).toMatchObject({ site: null })
  expect(sent).toEqual([])
})

it("BLOG_TOKEN goes only to BLOG_TOKEN_SITE, never to a profile's stored site", async () => {
  const bare = setup({ BLOG_TOKEN: "token-a" })
  await bare.cli(["two", "session", "start", "--site", "b.blog.test/news", "--json"], "token-b\n")
  bare.sent.length = 0
  const missing = await bare.cli(["two", "api", "list-posts", "--json"])
  expect(missing.error.message).toContain("session start --site")
  expect((await bare.cli(["two", "session", "status", "--check", "--json"])).error).toMatchObject({
    code: "authentication_error",
  })
  expect(bare.sent).toEqual([])
  const paired = setup({ BLOG_TOKEN: "token-a", BLOG_TOKEN_SITE: "a.blog.test" })
  expect((await paired.cli(["two", "api", "list-posts", "--json"])).json.item).toEqual([{ id: 1, site: "a.blog.test" }])
  expect(paired.sent).toEqual([{ url: "https://a.blog.test/wp-json/posts", authorization: "Bearer token-a" }])
})

it("a free variable inside a host takes one name, not a host with a path", async () => {
  const { manifestBaseUrl } = await import("./service-api-manifest.js")
  const sub = { ...manifest, servers: [{ url: "https://{site}.blog.test/v1", variables: {} }] }
  expect(manifestBaseUrl(sub, undefined, { site: "acme" })).toBe("https://acme.blog.test/v1")
  expect(() => manifestBaseUrl(sub, undefined, { site: "evil.test/x" })).toThrow("not one name without dots")
})

it("a password for a user name: --login keeps <name>:<password>, sent as Basic; piped in, no page note", async () => {
  const { cli, sent } = setup({}, true)
  expect((await cli(["one", "session", "start", "--site", "a.blog.test", "--json"], "token-a\n")).error).toMatchObject({
    code: "validation_error",
  })
  const colon = await cli(
    ["one", "session", "start", "--site", "a.blog.test", "--login", "ed:x", "--json"],
    "token-a\n",
  )
  expect(colon.error.message).toContain("colon")
  expect(sent).toEqual([])
  const started = await cli(
    ["one", "session", "start", "--site", "a.blog.test", "--login", "editor", "--json"],
    "token-a\n",
  )
  expect(started.json.item).toMatchObject({ site: "a.blog.test", verified: true })
  // The note where to make one is for a person at a terminal; piped, stderr holds only the answer's errors.
  expect(started.err).not.toContain("wp-admin")
  sent.length = 0
  expect((await cli(["one", "api", "list-posts", "--json"])).json.item).toEqual([{ id: 1, site: "a.blog.test" }])
  expect(sent).toEqual([
    {
      url: "https://a.blog.test/wp-json/posts",
      authorization: `Basic ${Buffer.from("editor:token-a").toString("base64")}`,
    },
  ])
})

it("Basic needs a user name: a token without one is refused, and a bearer alternative is preferred", async () => {
  const bare = setup({ BLOG_TOKEN: "token-a", BLOG_TOKEN_SITE: "a.blog.test" }, true)
  const refused = await bare.cli(["one", "api", "list-posts", "--json"])
  expect(refused.error.message).toContain("session start --login <name>")
  expect(bare.sent).toEqual([])
  const { signRequest } = await import("./service-api-manifest.js")
  const both = {
    ...manifest,
    securitySchemes: { basic: { type: "http", scheme: "basic" }, bearer: { type: "http", scheme: "bearer" } },
    security: [{ basic: [] }, { bearer: [] }],
  } as ServiceApiManifest
  const request = { url: new URL("https://a.blog.test/wp-json/posts"), headers: new Headers() }
  await signRequest(both, both.operations[0] as never, request, () => "token-a")
  expect(request.headers.get("authorization")).toBe("Bearer token-a")
})
