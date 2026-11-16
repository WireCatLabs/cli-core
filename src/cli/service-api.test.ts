import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { hostFetch } from "@wirecat/cli-base/http"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { commandPermissions } from "./permission-keys.js"
import { createProgram, run } from "./program.js"
import { type ServiceApiOperation, serviceApiPermissions } from "./service-api.js"
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

const page = (id: string): ServiceApiOperation["parameters"][number] => ({
  name: id,
  in: "path",
  required: true,
  schema: { type: "string" },
})

const operations: ServiceApiOperation[] = [
  {
    id: "retrieve-a-page",
    command: "retrieve-a-page",
    binding: { kind: "http", method: "GET", path: "/v1/pages/{page_id}" },
    effect: "read",
    tags: ["Pages"],
    parameters: [page("page_id")],
  },
  {
    id: "patch-page",
    command: "patch-page",
    binding: { kind: "http", method: "PATCH", path: "/v1/pages/{page_id}" },
    effect: "write",
    tags: ["Pages"],
    parameters: [page("page_id")],
    request: { required: true, confidence: "contract", schema: "PatchPage" },
    deletingFields: ["in_trash"],
  },
  {
    id: "delete-a-block",
    command: "delete-a-block",
    binding: { kind: "http", method: "DELETE", path: "/v1/blocks/{block_id}" },
    effect: "destructive",
    tags: ["Blocks"],
    parameters: [page("block_id")],
  },
  {
    id: "agent-batch",
    command: "agent-batch",
    binding: { kind: "http", method: "POST", path: "/v1/agents/batch" },
    effect: "write",
    tags: ["Agents"],
    parameters: [],
    request: { required: true, confidence: "contract" },
  },
  {
    id: "create-a-token",
    command: "create-a-token",
    binding: { kind: "http", method: "POST", path: "/v1/oauth/token" },
    effect: "write",
    tags: ["OAuth"],
    parameters: [],
    response: { confidence: "contract", sensitive: true },
  },
]

const api = {
  operations,
  deleteKey: "documents.delete",
  deletingBodies: {
    "agent-batch": (body: unknown) => {
      const steps = (body as { operations?: unknown } | null)?.operations
      return Array.isArray(steps) && steps.some((one) => (one as { action?: unknown } | null)?.action === "delete")
    },
  },
}

const fixture = (
  saved: Record<string, string> = {},
  answer: () => Response = () => Response.json({ object: "page", id: "p1" }),
  overrides: { deleteKey?: string | undefined } = {},
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
  const sent: { method: string; url: string; body?: string }[] = []
  const loads = { schemas: 0, definitions: 0 }
  const shared = serviceApiPermissions(api)
  const configuration = settingsFor(app, {
    permissions: commandPermissions(shared),
  })
  const definition = {
    app,
    configuration,
    commands: () => [
      serviceApiCommand({
        ...api,
        ...overrides,
        app,
        configuration,
        service: "Pages",
        baseUrl: "https://api.pages.test",
        fetch: () =>
          hostFetch({
            hosts: ["api.pages.test"],
            fetch: async (input, init) => {
              sent.push({
                method: init?.method ?? "GET",
                url: String(input),
                ...(typeof init?.body === "string" ? { body: init.body } : {}),
              })
              return answer()
            },
          }),
        headers: () => ({ authorization: "Bearer page-token" }),
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
      }),
    ],
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
  return { cli, sent, loads, root, env, definition }
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
    expect(listed.json.items.map((one: { command: string }) => one.command)).toEqual(["delete-a-block"])
    const shown = await cli("api", "show", "patch-page", "--json")
    expect(shown.json.item).toMatchObject({ api_version: "2026-03-11", request_schema: { type: "object" } })
    expect(loads).toEqual({ schemas: 0, definitions: 1 })
    expect((await cli("api", "show", "upload-file", "--json")).error?.message).toBe(
      "upload-file is not offered: sends multipart/form-data",
    )
    expect(sent).toEqual([])

    const read = await cli("work", "api", "retrieve-a-page", "--page-id", "p1", "--json")
    expect(read.json.item).toEqual({ object: "page", id: "p1" })
    expect(sent).toEqual([{ method: "GET", url: "https://api.pages.test/v1/pages/p1" }])
    expect(loads.schemas).toBe(1)
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

  it("**a delete checks the delete key**: by its method, a deleting field, or the CLI's test of the body", async () => {
    const { cli, sent } = fixture({ "documents.delete": "deny", api: "allow" })
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
    expect(sent).toEqual([{ method: "PATCH", url: "https://api.pages.test/v1/pages/p1", body: '{"in_trash":false}' }])
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

  it("**names its keys for --dry-run and discovery**, and starts deletes at ask", () => {
    const { alsoChecks, defaults } = serviceApiPermissions(api)
    expect(alsoChecks(["api", "delete-a-block"])).toEqual(["documents.delete"])
    expect(alsoChecks(["api", "patch-page"])).toEqual([
      { key: "documents.delete", when: "the body deletes, trashes or archives" },
    ])
    expect(alsoChecks(["api", "agent-batch"])).toHaveLength(1)
    expect(alsoChecks(["api", "retrieve-a-page"])).toEqual([])
    expect(defaults).toEqual({ "documents.delete": "ask", "api.delete-a-block": "ask" })
    expect(serviceApiPermissions(api).extra).toEqual(["documents.delete"])
    const named: ServiceApiOperation = { ...(operations[2] as ServiceApiOperation), deleteKey: "blocks.delete" }
    const own = serviceApiPermissions({ operations: [named] })
    expect(own.alsoChecks(["api", "delete-a-block"])).toEqual(["blocks.delete"])
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

  it("**refuses to build without a delete key when an operation can delete**, a DELETE marked as a write too", () => {
    const write: ServiceApiOperation = { ...(operations[2] as ServiceApiOperation), effect: "write" }
    expect(
      serviceApiPermissions({ operations: [write], deleteKey: "documents.delete" }).alsoChecks([
        "api",
        "delete-a-block",
      ]),
    ).toEqual(["documents.delete"])
    const { definition } = fixture({}, undefined, { deleteKey: undefined })
    expect(() => definition.commands()).toThrow(
      "patch-page, delete-a-block, agent-batch can delete, but no delete key is set: give the api a deleteKey",
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
