import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import type { ManifestOperation } from "@wirecat/cli-base/codegen"
import { hostFetch } from "@wirecat/cli-base/http"
import { Command } from "commander"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { outputFor } from "./context.js"
import { itemOf, renderAnswer } from "./envelope.js"
import { commandPermissions } from "./permission-keys.js"
import { createProgram, run } from "./program.js"
import { serviceApiPermissions, serviceApiWriter } from "./service-api.js"
import type { ServiceApiManifest } from "./service-api-manifest.js"
import { settingsFor } from "./settings.js"
import { serviceApiCommand } from "./shared-command-exports.js"

const app = {
  command: "pages",
  appName: "pages-cli",
  envPrefix: "PAGES",
  description: "a page service",
  version: "1.0.0",
  messenger: false,
}

type Operation = ManifestOperation

const page = (id: string): Operation["parameters"][number] => ({
  name: id,
  in: "path",
  required: true,
  schema: { type: "string" },
})
const query = (name: string, type: "string" | "integer" | "boolean" = "string"): Operation["parameters"][number] => ({
  name,
  in: "query",
  required: false,
  schema: { type },
})

const operations: Operation[] = [
  {
    id: "retrieve-a-page",
    command: "retrieve-a-page",
    binding: { kind: "http", method: "GET", path: "/pages/{page_id}" },
    effect: "read",
    tags: ["Pages"],
    parameters: [page("page_id")],
  },
  {
    id: "patch-page",
    command: "patch-page",
    binding: { kind: "http", method: "PATCH", path: "/pages/{page_id}" },
    effect: "write",
    tags: ["Pages"],
    parameters: [page("page_id")],
    request: { required: true, confidence: "contract", schema: "PatchPage" },
    permissions: [{ key: "documents.delete", body: ["in_trash", "archived"] }],
  },
  {
    id: "delete-a-block",
    command: "delete-a-block",
    binding: { kind: "http", method: "DELETE", path: "/blocks/{block_id}" },
    effect: "destructive",
    tags: ["Blocks"],
    parameters: [page("block_id")],
    permissions: [{ key: "documents.delete" }],
  },
  {
    id: "create-post",
    command: "create-post",
    binding: { kind: "http", method: "POST", path: "/posts" },
    effect: "write",
    tags: ["Posts"],
    parameters: [query("status")],
    request: { required: false, confidence: "contract", schema: "PatchPage" },
    permissions: [{ key: "posts.publish", values: { status: ["publish", "future"] } }],
  },
  {
    id: "update-post",
    command: "update-post",
    binding: { kind: "http", method: "POST", path: "/posts/{id}" },
    effect: "write",
    tags: ["Posts"],
    parameters: [page("id")],
    request: { required: false, confidence: "contract", schema: "PatchPage" },
    permissions: [
      {
        key: "posts.publish",
        values: { status: ["publish", "future"] },
        body: ["date", "date_gmt"],
        unless: { status: ["draft", "pending", "private"] },
      },
    ],
  },
  {
    id: "delete-post",
    command: "delete-post",
    binding: { kind: "http", method: "DELETE", path: "/posts/{id}" },
    effect: "destructive",
    tags: ["Posts"],
    parameters: [page("id"), query("force", "boolean")],
    permissions: [{ key: "posts.delete" }, { key: "posts.delete.force", query: ["force"] }],
  },
  {
    id: "list-posts",
    command: "list-posts",
    binding: { kind: "http", method: "GET", path: "/posts" },
    effect: "read",
    tags: ["Posts"],
    parameters: [query("page", "integer"), query("per_page", "integer")],
    pagination: {
      style: "page",
      page: { in: "query", name: "page" },
      limit: { in: "query", name: "per_page" },
      items: "",
      start: 1,
      pagesHeader: "x-wp-totalpages",
    },
  },
  {
    id: "agent-batch",
    command: "agent-batch",
    binding: { kind: "http", method: "POST", path: "/agents/batch" },
    effect: "write",
    tags: ["Agents"],
    parameters: [],
    request: { required: true, confidence: "contract" },
  },
  {
    id: "upload-link",
    command: "upload-link",
    binding: { kind: "http", method: "GET", path: "/upload" },
    effect: "read",
    tags: ["Files"],
    parameters: [query("path"), query("overwrite")],
    permissions: [{ key: "documents.delete", query: ["overwrite"] }],
  },
  {
    id: "list-pages",
    command: "list-pages",
    binding: { kind: "http", method: "GET", path: "/pages" },
    effect: "read",
    tags: ["Pages"],
    parameters: [query("start_cursor")],
    pagination: {
      style: "cursor",
      cursor: { in: "query", name: "start_cursor" },
      next: "next_cursor",
      items: "results",
      hasMore: "has_more",
    },
  },
  {
    id: "list-files",
    command: "list-files",
    binding: { kind: "http", method: "GET", path: "/files" },
    effect: "read",
    tags: ["Files"],
    parameters: [query("offset", "integer"), query("limit", "integer")],
    pagination: {
      style: "offset",
      offset: { in: "query", name: "offset" },
      limit: { in: "query", name: "limit" },
      items: "_embedded.items",
      total: "_embedded.total",
    },
  },
  {
    id: "list-uncounted",
    command: "list-uncounted",
    binding: { kind: "http", method: "GET", path: "/uncounted" },
    effect: "read",
    tags: [],
    parameters: [query("offset", "integer"), query("limit", "integer")],
    pagination: {
      style: "offset",
      offset: { in: "query", name: "offset" },
      limit: { in: "query", name: "limit" },
      items: "items",
    },
  },
  {
    id: "search",
    command: "search",
    binding: { kind: "http", method: "POST", path: "/search" },
    effect: "read",
    tags: [],
    parameters: [],
    pagination: {
      style: "cursor",
      cursor: { in: "body", name: "start_cursor" },
      next: "next_cursor",
      items: "results",
    },
  },
  {
    id: "list-events",
    command: "list-events",
    binding: { kind: "http", method: "GET", path: "/events" },
    effect: "read",
    tags: ["Events"],
    parameters: [],
    pagination: { style: "link", next: "links.next", items: "events" },
  },
  {
    id: "list-shared",
    command: "list-shared",
    binding: { kind: "http", method: "GET", path: "/shared" },
    effect: "read",
    tags: ["Files"],
    parameters: [query("cursor")],
    pagination: { style: "cursor", cursor: { in: "query", name: "cursor" }, next: "next", items: "items" },
    permissions: [{ key: "documents.share" }],
  },
  {
    id: "list-numbered",
    command: "list-numbered",
    binding: { kind: "http", method: "GET", path: "/numbered" },
    effect: "read",
    tags: [],
    parameters: [query("page")],
    pagination: { style: "page", page: { in: "query", name: "page" }, items: "rows" },
  },
  {
    id: "maybe-signed",
    command: "maybe-signed",
    binding: { kind: "http", method: "GET", path: "/maybe" },
    effect: "read",
    tags: [],
    parameters: [],
    security: [{}, { oauth: [] }],
  },
  {
    id: "status",
    command: "status",
    binding: { kind: "http", method: "GET", path: "/status" },
    effect: "read",
    tags: [],
    parameters: [],
    security: [],
  },
  {
    id: "create-a-token",
    command: "create-a-token",
    binding: { kind: "http", method: "POST", path: "/oauth/token" },
    effect: "write",
    tags: ["OAuth"],
    parameters: [],
    response: { confidence: "contract", sensitive: true },
  },
]

const manifest: ServiceApiManifest = {
  operations,
  servers: [{ url: "https://api.pages.test/{version}", variables: { version: { default: "v1", enum: ["v1"] } } }],
  securitySchemes: { oauth: { type: "http", scheme: "OAuth" } },
  security: [{ oauth: [] }],
}

const api = {
  manifest,
  bodyPermissions: {
    "agent-batch": [
      {
        key: "documents.delete",
        when: "an operation's action is delete",
        applies: (body: unknown) => {
          const steps = (body as { operations?: unknown } | null)?.operations
          return Array.isArray(steps) && steps.some((one) => (one as { action?: unknown } | null)?.action === "delete")
        },
      },
    ],
  },
}

type Sent = {
  method: string
  url: string
  body?: string
  bytes?: number[]
  type?: string
  authorization?: string
  key?: string
  redirect?: string
  version?: string
}

const fixture = (
  saved: Record<string, string> = {},
  answer: (sent: Sent) => Response = () => Response.json({ object: "page", id: "p1" }),
  over: Partial<typeof api> & { signsIn?: false } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "service-api-"))
  const env = {
    PAGES_CONFIG_DIR: join(root, "config"),
    PAGES_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "w.db"),
  }
  mkdirSync(env.PAGES_CONFIG_DIR, { recursive: true })
  writeFileSync(
    join(env.PAGES_CONFIG_DIR, "config.json"),
    JSON.stringify({ profiles: { work: { permissions: saved } } }),
  )
  const sent: Sent[] = []
  const loads = { schemas: 0, definitions: 0 }
  const shared = serviceApiPermissions({ ...api, ...over })
  const configuration = settingsFor(app, { permissions: commandPermissions(shared) })
  const options = {
    ...api,
    ...over,
    app,
    configuration,
    service: "Pages",
    fetch: () =>
      hostFetch({
        hosts: ["api.pages.test"],
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers)
          const authorization = headers.get("authorization")
          const key = headers.get("x-api-key")
          const version = headers.get("markdown-version")
          const one: Sent = {
            method: init?.method ?? "GET",
            url: String(input),
            ...(typeof init?.body === "string" ? { body: init.body } : {}),
            ...(init?.body instanceof Uint8Array
              ? { bytes: [...init.body], type: headers.get("content-type") ?? "" }
              : {}),
            ...(authorization ? { authorization } : {}),
            ...(key ? { key, redirect: String(init?.redirect) } : {}),
            ...(version ? { version } : {}),
          }
          sent.push(one)
          return answer(one)
        },
      }),
    ...(over.signsIn === false ? {} : { token: () => "page-token" }),
    headers: () => ({ "pages-version": "2026-03-11" }),
    schemas: async () => {
      loads.schemas++
      return { PatchPage: v.looseObject({ in_trash: v.optional(v.boolean()) }) }
    },
    definitions: async () => {
      loads.definitions++
      return { PatchPage: { type: "object", properties: {} } } as never
    },
    excluded: [{ id: "upload-file", reason: "sends multipart/form-data" }],
    shown: { api_version: "2026-03-11" },
  }
  // A content command's write: the writer from code, with the keys the command already asked about.
  const writer = new Command("write")
    .argument("<operation>")
    .option("--id <id>")
    .option("--body <json>")
    .option("--query <json>")
    .option("--headers <json>")
    .option("--confirmed <keys>")
    .action(async function (this: Command, operation: string) {
      const given = this.opts<{ id?: string; body?: string; query?: string; headers?: string; confirmed?: string }>()
      const result = await serviceApiWriter(options)(
        this,
        operation,
        {
          path: given.id ? { id: given.id } : {},
          query: JSON.parse(given.query ?? "{}"),
          headers: JSON.parse(given.headers ?? "{}"),
          fields: {},
          ...(given.body ? { body: given.body } : {}),
        },
        given.confirmed ? { confirmed: given.confirmed.split(",") } : {},
      )
      renderAnswer(this, outputFor(this), itemOf(result))
    })
  const definition = {
    app,
    configuration,
    commands: () => [serviceApiCommand(options), writer],
  }
  const cli = async (...args: string[]) => {
    const streams = captureStreams()
    const code = await run(args, definition, { streams, env, tty: false })
    const out = streams.stdout.join("")
    const err = streams.stderr.join("")
    return {
      code,
      json: out.startsWith("{") ? JSON.parse(out) : undefined,
      error: err.startsWith("{") ? (JSON.parse(err).error as { code: string; message: string }) : undefined,
    }
  }
  const bare = (one: Sent) => ({ method: one.method, url: one.url, ...(one.body ? { body: one.body } : {}) })
  return { cli, sent, bare: () => sent.map(bare), loads, root, env, definition }
}

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })

describe("the shared service api group", () => {
  it("**lists and shows operations without a request or the schemas**, and loads them for an operation", async () => {
    const { cli, sent, loads } = fixture()
    const listed = await cli("api", "list", "effect:destructive", "--json")
    expect(listed.json.items.map((one: { command: string }) => one.command)).toEqual(["delete-a-block", "delete-post"])
    const shown = await cli("api", "show", "patch-page", "--json")
    expect(shown.json.item).toMatchObject({ api_version: "2026-03-11", request_schema: { type: "object" } })
    expect(loads).toEqual({ schemas: 0, definitions: 1 })
    expect((await cli("api", "show", "upload-file", "--json")).error?.message).toBe(
      "upload-file is not offered: sends multipart/form-data",
    )
    expect(sent).toEqual([])

    const read = await cli("work", "api", "retrieve-a-page", "--page-id", "p1", "--json")
    expect(read.json.item).toEqual({ object: "page", id: "p1" })
    expect(sent).toEqual([
      { method: "GET", url: "https://api.pages.test/v1/pages/p1", authorization: "OAuth page-token" },
    ])
    expect(loads.schemas).toBe(1)
  })

  it("**signs in only where the manifest asks for it**: no header for an operation with `security: []`", async () => {
    const { cli, sent } = fixture()
    expect((await cli("work", "api", "status", "--json")).code).toBe(0)
    expect(sent).toEqual([{ method: "GET", url: "https://api.pages.test/v1/status" }])
  })

  it("**sends no sign-in where the spec names none, or for a CLI without one**, the token never read", async () => {
    const silent = fixture({}, undefined, {
      manifest: { operations, ...(manifest.servers ? { servers: manifest.servers } : {}) },
    })
    expect((await silent.cli("work", "api", "retrieve-a-page", "--page-id", "p1", "--json")).code).toBe(0)
    expect(silent.sent).toEqual([{ method: "GET", url: "https://api.pages.test/v1/pages/p1" }])
    const unsigned = fixture({}, undefined, { signsIn: false })
    expect((await unsigned.cli("work", "api", "retrieve-a-page", "--page-id", "p1", "--json")).code).toBe(0)
    expect(unsigned.sent).toEqual([{ method: "GET", url: "https://api.pages.test/v1/pages/p1" }])
  })

  it("**sends a required parameter's default when its flag is left out**, as Notion's `Notion-Version`", async () => {
    const markdown: Operation = {
      id: "page-markdown",
      command: "page-markdown",
      binding: { kind: "http", method: "GET", path: "/pages/{page_id}/markdown" },
      effect: "read",
      tags: [],
      parameters: [
        page("page_id"),
        { name: "Markdown-Version", in: "header", required: true, schema: { type: "string", default: "2026-03-11" } },
        { name: "format", in: "query", required: true, schema: { type: "string" } },
      ],
    }
    const { cli, sent, definition } = fixture({}, undefined, {
      manifest: { ...manifest, operations: [...operations, markdown] },
    })
    const command = createProgram(definition)
      .commands.find((one) => one.name() === "api")
      ?.commands.find((one) => one.name() === "page-markdown")
    const option = (long: string) => command?.options.find((one) => one.long === long)
    expect(option("--markdown-version")).toMatchObject({ mandatory: false, defaultValue: "2026-03-11" })
    expect(option("--format")?.mandatory).toBe(true)

    const missing = await cli("work", "api", "page-markdown", "--page-id", "p1", "--json")
    expect(missing.error?.message).toBe("required option '--format <value>' not specified")
    expect((await cli("work", "api", "page-markdown", "--page-id", "p1", "--format", "md", "--json")).code).toBe(0)
    expect(
      (
        await cli(
          ...["work", "api", "page-markdown", "--page-id", "p2", "--format", "md", "--markdown-version", "2027-01-01"],
          "--json",
        )
      ).code,
    ).toBe(0)
    expect(sent).toEqual([
      expect.objectContaining({ url: "https://api.pages.test/v1/pages/p1/markdown?format=md", version: "2026-03-11" }),
      expect.objectContaining({ url: "https://api.pages.test/v1/pages/p2/markdown?format=md", version: "2027-01-01" }),
    ])
  })

  it("**uploads a file's bytes with --body-file**, as Petstore's octet-stream body, and leaves out a multipart form", async () => {
    const http = (path: string) => ({ kind: "http" as const, method: "POST" as const, path })
    const upload: Operation = {
      id: "uploadFile",
      command: "upload-file",
      binding: http("/pages/{page_id}/image"),
      effect: "write",
      tags: [],
      parameters: [page("page_id")],
      request: { required: false, confidence: "contract", contentType: "application/octet-stream" },
    }
    const form: Operation = {
      id: "importContacts",
      command: "import-contacts",
      binding: http("/imports"),
      effect: "write",
      tags: [],
      parameters: [],
      request: { required: true, confidence: "contract", contentType: "multipart/form-data" },
    }
    const { cli, sent, root, env } = fixture({ api: "allow" }, undefined, {
      manifest: { ...manifest, operations: [...operations, upload, form] },
    })
    const image = join(root, "pet.png")
    writeFileSync(image, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))
    expect((await cli("work", "api", "upload-file", "--page-id", "p1", "--body-file", image, "--json")).code).toBe(0)
    expect(sent).toEqual([
      {
        method: "POST",
        url: "https://api.pages.test/v1/pages/p1/image",
        bytes: [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff],
        type: "application/octet-stream",
        authorization: "OAuth page-token",
      },
    ])
    expect((await cli("work", "api", "upload-file", "--page-id", "p1", "--body", "{}", "--json")).code).not.toBe(0)
    const inside = join(env.PAGES_CONFIG_DIR, "config.json")
    const refused = await cli("work", "api", "upload-file", "--page-id", "p1", "--body-file", inside, "--json")
    expect(refused.error).toMatchObject({ code: "validation_error" })
    expect((await cli("api", "show", "import-contacts", "--json")).error?.message).toBe(
      "import-contacts is not offered: it sends multipart/form-data, which the generated command cannot send",
    )
    const listed = await cli("api", "list", "--json")
    expect(listed.json.items.map((one: { command: string }) => one.command)).not.toContain("import-contacts")
    expect(sent).toHaveLength(1)
  })

  it("**offers no free-form call, no --store-token and no credential-returning operation**", async () => {
    const group = createProgram(fixture().definition).commands.find((one) => one.name() === "api")
    const paths = JSON.stringify(
      group?.commands.map((one) => [one.name(), one.description(), one.options.map((option) => option.long)]),
    )
    expect(paths).toContain("patch-page")
    expect(group?.commands.map((one) => one.name())).not.toContain("call")
    expect(group?.description()).toBe("the raw Pages API, one command per operation of its OpenAPI document")
    expect(paths).not.toContain("create-a-token")
    expect(paths).not.toContain("store-token")
    expect(paths).not.toMatch(/Bot API/)
  })

  it("**a delete checks the manifest's key**: by its method, a deleting field, or the CLI's test of the body", async () => {
    const { cli, sent, bare } = fixture({ "documents.delete": "deny", api: "allow" })
    const byMethod = await cli("work", "api", "delete-a-block", "--block-id", "b1", "--json")
    expect(byMethod.error).toMatchObject({ code: "permission_error" })
    expect(byMethod.error?.message).toContain("documents.delete")
    const byField = await cli("work", "api", "patch-page", "--page-id", "p1", "--body", '{"in_trash":true}', "--json")
    expect(byField.error).toMatchObject({ code: "permission_error" })
    const byBody = await cli("work", "api", "agent-batch", "--body", '{"operations":[{"action":"delete"}]}', "--json")
    expect(byBody.error).toMatchObject({ code: "permission_error" })
    expect(sent).toEqual([])

    const kept = await cli("work", "api", "patch-page", "--page-id", "p1", "--body", '{"in_trash":false}', "--json")
    expect(kept.code).toBe(0)
    expect(kept.json.item).toMatchObject({ operation_id: expect.any(String), result: { id: "p1" } })
    expect(bare()).toEqual([{ method: "PATCH", url: "https://api.pages.test/v1/pages/p1", body: '{"in_trash":false}' }])
  })

  it("**a write whose field holds a publishing value checks its key**, in the body or the query, as WordPress", async () => {
    const { cli, bare } = fixture({ "posts.publish": "deny", api: "allow" })
    for (const call of [
      ["--body", '{"status":"publish","title":"t"}'],
      ["--body", '{"status":"future"}'],
      ["--status", "publish", "--body", '{"title":"t"}'],
    ]) {
      const refused = await cli("work", "api", "create-post", ...call, "--json")
      expect(refused.error).toMatchObject({ code: "permission_error" })
      expect(refused.error?.message).toContain("posts.publish")
    }
    expect(bare()).toEqual([])
    const draft = await cli("work", "api", "create-post", "--body", '{"status":"draft","title":"t"}', "--json")
    expect(draft.code).toBe(0)
    expect(bare()).toEqual([
      { method: "POST", url: "https://api.pages.test/v1/posts", body: '{"status":"draft","title":"t"}' },
    ])
  })

  it("**a date change needs the publish key unless the call keeps the post a draft**, as WordPress publishes a past date", async () => {
    const { cli, bare } = fixture({ "posts.publish": "deny", api: "allow" })
    for (const body of [
      '{"date":"2000-01-01T00:00:00"}',
      '{"date_gmt":"2000-01-01","status":"future"}',
      '{"date":null}',
    ])
      expect((await cli("work", "api", "update-post", "--id", "5", "--body", body, "--json")).error).toMatchObject({
        code: "permission_error",
      })
    expect(bare()).toEqual([])
    for (const status of ["draft", "pending", "private"]) {
      const kept = await cli(
        "work",
        "api",
        "update-post",
        "--id",
        "5",
        "--body",
        `{"date":"2000-01-01","status":"${status}"}`,
      )
      expect(kept.code).toBe(0)
    }
    expect(bare()).toHaveLength(3)
  })

  it("**the writer passes the api group's guard**: publish, date, force and the profile's levels", async () => {
    const { cli, bare } = fixture({ "posts.publish": "deny", "posts.delete.force": "deny", api: "allow" })
    const refused = [
      ["update-post", "--id", "5", "--body", '{"status":"publish"}'],
      ["update-post", "--id", "5", "--body", '{"date":"2000-01-01"}'],
      ["update-post", "--id", "5", "--body", '{"status":"publish"}', "--confirmed", "posts.publish"],
      ["delete-post", "--id", "5", "--query", '{"force":"true"}'],
    ]
    for (const call of refused)
      expect((await cli("work", "write", ...call, "--json")).error).toMatchObject({ code: "permission_error" })
    expect(bare()).toEqual([])
    const trashed = await cli("work", "write", "delete-post", "--id", "5", "--yes", "--json")
    expect(trashed.json.item).toMatchObject({ operation_id: expect.any(String), result: { id: "p1" } })
    const draft = await cli(
      "work",
      "write",
      "update-post",
      "--id",
      "5",
      "--body",
      '{"date":"2000-01-01","status":"draft"}',
    )
    expect(draft.code).toBe(0)
    expect(bare().map(({ method, url }) => `${method} ${url}`)).toEqual([
      "DELETE https://api.pages.test/v1/posts/5",
      "POST https://api.pages.test/v1/posts/5",
    ])
  })

  it("**the writer asks once per key**: a key the caller confirmed is not asked again, every other still is", async () => {
    const { cli, bare } = fixture({ "posts.publish": "ask", api: "allow" })
    const unasked = await cli("work", "write", "update-post", "--id", "5", "--body", '{"status":"publish"}', "--json")
    expect(unasked.error?.code).toBe("confirmation_required")
    expect(bare()).toEqual([])
    const confirmed = await cli(
      "work",
      "write",
      "update-post",
      "--id",
      "5",
      "--body",
      '{"status":"publish"}',
      "--confirmed",
      "posts.publish",
    )
    expect(confirmed.code).toBe(0)
    expect(bare()).toHaveLength(1)
    const forced = fixture({ "posts.delete": "ask", "posts.delete.force": "ask", api: "allow" })
    const half = await forced.cli(
      "work",
      "write",
      "delete-post",
      "--id",
      "5",
      "--query",
      '{"force":"true"}',
      "--confirmed",
      "posts.delete.force",
      "--json",
    )
    expect(half.error?.code).toBe("confirmation_required")
    expect(half.error?.message).toContain("posts.delete")
    expect(half.error?.message).not.toContain("posts.delete.force")
    expect(forced.sent).toEqual([])
  })

  it("**the writer reaches no further than the api group**: no undeclared query, no method override, no plain read", async () => {
    const { cli, sent } = fixture({ api: "allow" })
    for (const call of [
      ["update-post", "--id", "5", "--query", '{"_method":"DELETE","force":"true"}'],
      ["update-post", "--id", "5", "--headers", '{"X-HTTP-Method-Override":"DELETE"}'],
      ["update-post", "--id", "5", "--headers", '{"X-HTTP-Method":"DELETE"}'],
      ["retrieve-a-page"],
    ])
      expect((await cli("work", "write", ...call, "--json")).error).toMatchObject({ code: "configuration_error" })
    expect(sent).toEqual([])
  })

  it("**a read whose query flag deletes goes through the guard**, as an upload link that overwrites", async () => {
    const { cli, bare } = fixture({ "documents.delete": "deny" })
    const refused = await cli("work", "api", "upload-link", "--path", "/a.txt", "--overwrite", "true", "--json")
    expect(refused.error).toMatchObject({ code: "permission_error" })
    expect(bare()).toEqual([])
    const plain = await cli("work", "api", "upload-link", "--path", "/a.txt", "--overwrite", "false", "--json")
    expect(plain.json.item).toEqual({ object: "page", id: "p1" })
    expect(bare()).toEqual([{ method: "GET", url: "https://api.pages.test/v1/upload?path=%2Fa.txt&overwrite=false" }])
  })

  it("**--dry-run previews a write and sends nothing**", async () => {
    const { cli, sent } = fixture({ api: "allow" })
    const previewed = await cli("work", "api", "patch-page", "--page-id", "p1", "--body", "{}", "--dry-run", "--json")
    expect(previewed.code).toBe(0)
    expect(previewed.json.item.permission).toMatchObject({ key: "api.patch-page", level: "allow" })
    expect(JSON.stringify(previewed.json.item)).toContain("documents.delete")
    expect(sent).toEqual([])
  })

  it("**denying api.<operation> refuses it before anything is sent**", async () => {
    const { cli, sent } = fixture({ "api.patch-page": "deny" })
    const refused = await cli("work", "api", "patch-page", "--page-id", "p1", "--body", "{}", "--json")
    expect(refused.error).toMatchObject({ code: "permission_error" })
    expect(sent).toEqual([])
  })

  it("**names the manifest's keys for --dry-run and discovery**, and starts them at ask", () => {
    const { alsoChecks, defaults, extra } = serviceApiPermissions(api)
    expect(alsoChecks(["api", "delete-a-block"])).toEqual(["documents.delete"])
    expect(alsoChecks(["api", "patch-page"])).toEqual([
      { key: "documents.delete", when: "with in_trash or archived set" },
    ])
    expect(alsoChecks(["api", "upload-link"])).toEqual([{ key: "documents.delete", when: "with overwrite set" }])
    expect(alsoChecks(["api", "create-post"])).toEqual([
      { key: "posts.publish", when: "with status publish or future" },
    ])
    expect(alsoChecks(["api", "update-post"])).toEqual([
      {
        key: "posts.publish",
        when: "with status publish or future or date or date_gmt set, unless status draft or pending or private",
      },
    ])
    expect(alsoChecks(["api", "delete-post"])).toEqual([
      "posts.delete",
      { key: "posts.delete.force", when: "with force set" },
    ])
    expect(alsoChecks(["api", "agent-batch"])).toEqual([
      { key: "documents.delete", when: "an operation's action is delete" },
    ])
    expect(alsoChecks(["api", "retrieve-a-page"])).toEqual([])
    expect(defaults).toEqual({
      "documents.delete": "ask",
      "posts.publish": "ask",
      "posts.delete": "ask",
      "posts.delete.force": "ask",
      "documents.share": "ask",
      "api.delete-a-block": "ask",
      "api.delete-post": "ask",
    })
    expect(extra).toEqual([
      "documents.delete",
      "posts.publish",
      "posts.delete",
      "posts.delete.force",
      "documents.share",
    ])
  })

  it("**--all reads every page** by the manifest's cursor, offset or link, in one run", async () => {
    const cursor = fixture({}, ({ url }) =>
      url.includes("start_cursor=c2")
        ? Response.json({ results: [3], next_cursor: null, has_more: false })
        : Response.json({ results: [1, 2], next_cursor: "c2", has_more: true }),
    )
    const pages = await cursor.cli("work", "api", "list-pages", "--all", "--json")
    expect(pages.json.items).toEqual([1, 2, 3])
    expect(cursor.bare().map(({ url }) => url)).toEqual([
      "https://api.pages.test/v1/pages",
      "https://api.pages.test/v1/pages?start_cursor=c2",
    ])

    const offset = fixture({}, ({ url }) => {
      const at = Number(new URL(url).searchParams.get("offset") ?? 0)
      return Response.json({ _embedded: { items: at < 6 ? [at, at + 1] : [], total: 6 } })
    })
    const files = await offset.cli("work", "api", "list-files", "--limit", "2", "--all", "--json")
    expect(files.json.items).toEqual([0, 1, 2, 3, 4, 5])
    expect(offset.bare()).toHaveLength(3)

    const link = fixture({}, ({ url }) =>
      url.endsWith("/events")
        ? Response.json({ events: ["a"], links: { next: "/v1/events?page=2" } })
        : Response.json({ events: ["b"], links: {} }),
    )
    expect((await link.cli("work", "api", "list-events", "--all", "--json")).json.items).toEqual(["a", "b"])
    expect(link.sent.every(({ authorization }) => authorization === "OAuth page-token")).toBe(true)

    const away = fixture({}, () => Response.json({ events: ["a"], links: { next: "https://evil.test/steal" } }))
    const refused = await away.cli("work", "api", "list-events", "--all", "--json")
    expect(refused.error).toMatchObject({ code: "invalid_response" })
    expect(away.sent).toHaveLength(1)
    const unpaged = await away.cli("work", "api", "retrieve-a-page", "--page-id", "p1", "--all", "--json")
    expect(unpaged.error?.message).toMatch(/unknown option '--all'/)
  })

  it("**keeps a write's body out of every file the run leaves**, run record and argv log included (SEC-196)", async () => {
    const { cli, root } = fixture({ api: "allow" })
    const marker = "secret-body-marker-196"
    const body = JSON.stringify({ properties: { title: marker } })
    const sent = await cli("work", "api", "patch-page", "--page-id", "p1", "--body", body, "--record", "--json")
    expect(sent.code).toBe(0)
    const file = join(root, "body.json")
    writeFileSync(file, body)
    const fromFile = await cli(
      "work",
      "api",
      "patch-page",
      "--page-id",
      "p2",
      "--body-file",
      file,
      "--record",
      "--json",
    )
    expect(fromFile.code).toBe(0)
    const files = filesUnder(root).filter((one) => one !== file)
    expect(files.filter((one) => one.endsWith("run.json")).length).toBeGreaterThanOrEqual(2)
    for (const one of files) expect(readFileSync(one).includes(marker), one).toBe(false)
  })

  it("**a write the service never answered is outcome_unknown, and its body stays out of the files**", async () => {
    const { cli, root } = fixture({ api: "allow" }, () => {
      throw new TypeError("fetch failed")
    })
    const marker = "secret-lost-body-196"
    const lost = await cli(
      "work",
      "api",
      "patch-page",
      "--page-id",
      "p1",
      "--body",
      JSON.stringify({ properties: { title: marker } }),
      "--json",
    )
    expect(lost.error).toMatchObject({ code: "outcome_unknown" })
    for (const one of filesUnder(root)) expect(readFileSync(one).includes(marker), one).toBe(false)
  })

  it("**a flag counts unless it is plainly false**: `1` or `True` overwrites as `true` does", async () => {
    const { cli, bare } = fixture({ "documents.delete": "deny" })
    for (const value of ["1", "True", "yes"])
      expect((await cli("work", "api", "upload-link", "--overwrite", value, "--json")).error, value).toMatchObject({
        code: "permission_error",
      })
    const loose = await cli("work", "api", "patch-page", "--page-id", "p1", "--body", '{"archived":1}', "--json")
    expect(loose.error).toMatchObject({ code: "permission_error" })
    const typed = await cli("work", "api", "patch-page", "--page-id", "p1", "--body", '{"in_trash":1}', "--json")
    expect(typed.error).toMatchObject({ code: "validation_error" })
    expect(bare()).toEqual([])
  })

  it("**--all never pages past a guard**, stops on a repeated page and follows a relative link from the request", async () => {
    const asked = fixture({ "documents.share": "ask" })
    const refused = await asked.cli("work", "api", "list-shared", "--all", "--json")
    expect(refused.error).toMatchObject({ code: "validation_error" })
    expect(asked.sent).toEqual([])
    const denied = fixture({ "documents.share": "deny" })
    expect((await denied.cli("work", "api", "list-shared", "--all", "--json")).error).toMatchObject({
      code: "permission_error",
    })
    expect((await denied.cli("work", "api", "list-shared", "--json")).error).toMatchObject({ code: "permission_error" })
    expect(denied.sent).toEqual([])
    const allowed = fixture({ "documents.share": "allow" }, () => Response.json({ items: ["a"], next: null }))
    expect((await allowed.cli("work", "api", "list-shared", "--all", "--json")).json.items).toEqual(["a"])
    expect((await allowed.cli("work", "api", "list-shared", "--json")).json).not.toHaveProperty("operation_id")

    const stuck = fixture({}, () => Response.json({ results: [1], next_cursor: "same", has_more: true }))
    const looped = await stuck.cli("work", "api", "list-pages", "--all", "--json")
    expect(looped.error).toMatchObject({ code: "invalid_response" })
    expect(stuck.sent).toHaveLength(2)

    const relative = fixture({}, ({ url }) =>
      url.includes("page=2")
        ? Response.json({ events: ["b"], links: {} })
        : Response.json({ events: ["a"], links: { next: "events?page=2" } }),
    )
    expect((await relative.cli("work", "api", "list-events", "--all", "--json")).json.items).toEqual(["a", "b"])
    expect(relative.bare().map(({ url }) => url)).toEqual([
      "https://api.pages.test/v1/events",
      "https://api.pages.test/v1/events?page=2",
    ])

    const elsewhere = fixture({}, () => Response.json({ events: ["a"], links: { next: "/v2/events?page=2" } }))
    const left = await elsewhere.cli("work", "api", "list-events", "--all", "--json")
    expect(left.error).toMatchObject({ code: "invalid_response" })
    expect(elsewhere.sent).toHaveLength(1)
  })

  it("**--all by page number starts where the caller says** and stops on an empty page", async () => {
    const numbered = fixture({}, ({ url }) => Response.json({ rows: url.endsWith("page=2") ? [] : ["x"] }))
    const missing = await numbered.cli("work", "api", "list-numbered", "--all", "--json")
    expect(missing.error).toMatchObject({ code: "validation_error" })
    expect(numbered.sent).toEqual([])
    const all = await numbered.cli("work", "api", "list-numbered", "--page", "0", "--all", "--json")
    expect(all.error).toBeUndefined()
    expect(all.json.items).toEqual(["x", "x"])
    expect(numbered.sent.map(({ url }) => url.split("?")[1])).toEqual(["page=0", "page=1", "page=2"])
  })

  it("**--all stops at the page count a header gives**, from the source's first page, the answer being the list", async () => {
    const counted = fixture({}, ({ url }) => {
      const at = Number(new URL(url).searchParams.get("page") ?? 1)
      return Response.json([`p${at}`], { headers: { "X-WP-TotalPages": "3" } })
    })
    const all = await counted.cli("work", "api", "list-posts", "--per-page", "1", "--all", "--json")
    expect(all.json.items).toEqual(["p1", "p2", "p3"])
    expect(counted.sent.map(({ url }) => url.split("?")[1])).toEqual([
      "per_page=1",
      "per_page=1&page=2",
      "per_page=1&page=3",
    ])
  })

  it("**--all pages past a capped page until an empty one**, and carries a body cursor", async () => {
    const capped = fixture({}, ({ url }) => {
      const at = Number(new URL(url).searchParams.get("offset") ?? 0)
      return Response.json({ items: at < 4 ? [at, at + 1] : [] })
    })
    const all = await capped.cli("work", "api", "list-uncounted", "--limit", "5", "--all", "--json")
    expect(all.json.items).toEqual([0, 1, 2, 3])
    expect(capped.sent).toHaveLength(3)

    const searched = fixture({}, ({ body }) =>
      body?.includes("c2")
        ? Response.json({ results: ["b"], next_cursor: null })
        : Response.json({ results: ["a"], next_cursor: "c2" }),
    )
    expect((await searched.cli("work", "api", "search", "--all", "--json")).json.items).toEqual(["a", "b"])
    expect(searched.bare().map(({ body }) => body)).toEqual([undefined, '{"start_cursor":"c2"}'])
  })

  it("**the CLI's paging settings never read an operation's own --page**, with or without --dry-run", async () => {
    const { cli } = fixture()
    const previewed = await cli("work", "api", "list-numbered", "--page", "0", "--dry-run", "--json")
    expect(previewed.error).toBeUndefined()
  })

  it("**an optional sign-in still sends the token**; an API key header is never carried through a redirect", async () => {
    const { cli, sent } = fixture()
    expect((await cli("work", "api", "maybe-signed", "--json")).code).toBe(0)
    expect(sent[0]?.authorization).toBe("OAuth page-token")

    const keyed = {
      ...manifest,
      securitySchemes: { key: { type: "apiKey" as const, in: "header" as const, name: "X-Api-Key" } },
      security: [{ key: [] }],
    }
    const keyedFixture = fixture({}, undefined, { manifest: keyed })
    expect((await keyedFixture.cli("work", "api", "retrieve-a-page", "--page-id", "p1", "--json")).code).toBe(0)
    expect(keyedFixture.sent).toEqual([
      { method: "GET", url: "https://api.pages.test/v1/pages/p1", key: "page-token", redirect: "manual" },
    ])
    const moved = fixture({}, () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }), {
      manifest: keyed,
    })
    const refused = await moved.cli("work", "api", "retrieve-a-page", "--page-id", "p1", "--json")
    expect(refused.error).toMatchObject({ code: "provider_error" })
    expect(JSON.stringify(refused.error)).not.toContain('"sent":false')
    expect(moved.sent).toHaveLength(1)
  })

  it("**a key in the query goes on every page of --all**, and never through a redirect", async () => {
    const keyed = {
      ...manifest,
      securitySchemes: { key: { type: "apiKey" as const, in: "query" as const, name: "api_key" } },
      security: [{ key: [] }],
    }
    const link = fixture(
      {},
      ({ url }) =>
        url.includes("page=2")
          ? Response.json({ events: ["b"], links: {} })
          : Response.json({ events: ["a"], links: { next: "/v1/events?page=2&api_key=stale" } }),
      { manifest: keyed },
    )
    expect((await link.cli("work", "api", "list-events", "--all", "--json")).json.items).toEqual(["a", "b"])
    expect(link.sent.map(({ url, authorization }) => ({ url, authorization }))).toEqual([
      { url: "https://api.pages.test/v1/events?api_key=page-token", authorization: undefined },
      { url: "https://api.pages.test/v1/events?page=2&api_key=page-token", authorization: undefined },
    ])
    const moved = fixture({}, () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }), {
      manifest: keyed,
    })
    const refused = await moved.cli("work", "api", "retrieve-a-page", "--page-id", "p1", "--json")
    expect(refused.error).toMatchObject({ code: "provider_error" })
    expect(moved.sent).toHaveLength(1)
    const either: ServiceApiManifest = {
      ...keyed,
      securitySchemes: { ...keyed.securitySchemes, bearer: { type: "http" as const, scheme: "bearer" } },
      security: [{ key: [] }, { bearer: [] }],
    }
    const header = fixture({}, undefined, { manifest: either })
    expect((await header.cli("work", "api", "retrieve-a-page", "--page-id", "p1", "--json")).code).toBe(0)
    expect(header.sent).toEqual([
      { method: "GET", url: "https://api.pages.test/v1/pages/p1", authorization: "Bearer page-token" },
    ])
  })

  it("**refuses a free server variable, a plain-http base and a body key the manifest does not name**", () => {
    const free = {
      ...manifest,
      servers: [{ url: "https://{subdomain}.pages.test", variables: { subdomain: { default: "acme" } } }],
    }
    expect(() => fixture({}, undefined, { manifest: free }).definition.commands()).toThrow("give the api a baseUrl")
    const own = { "agent-batch": [{ key: "agents.delete", when: "always", applies: () => true }] }
    expect(() => fixture({}, undefined, { bodyPermissions: own }).definition.commands()).toThrow(
      "bodyPermissions name agents.delete, which the manifest does not",
    )
  })

  it("**refuses to build when a delete has no delete key in the manifest**, a DELETE marked as a write too", () => {
    const { permissions: _, ...bare } = operations[2] as Operation
    const unguarded = { ...manifest, operations: [{ ...bare, effect: "write" as const }] }
    const { definition } = fixture({}, undefined, { manifest: unguarded })
    expect(() => definition.commands()).toThrow(
      "delete-a-block can delete, but the manifest gives no delete key: generate with `permissions`",
    )
  })

  it("**refuses a --body-file in the CLI's own folders**, where sign-ins live", async () => {
    const { cli, env, sent } = fixture({ api: "allow" })
    const inside = join(env.PAGES_CONFIG_DIR, "tokens.json")
    writeFileSync(inside, '{"in_trash":false}')
    const refused = await cli("work", "api", "patch-page", "--page-id", "p1", "--body-file", inside, "--json")
    expect(refused.error).toMatchObject({ code: "validation_error" })
    expect(sent).toEqual([])
  })
})
