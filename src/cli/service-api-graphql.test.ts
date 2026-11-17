import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import {
  adaptGraphql,
  definitionsGenerator,
  type GraphqlFakeAnswer,
  type GraphqlFakeCall,
  generate,
  graphqlFake,
  manifestGenerator,
  type SchemaNode,
} from "@wirecat/cli-base/codegen"
import { integer } from "@wirecat/cli-base/codegen/runtime"
import { hostFetch } from "@wirecat/cli-base/http"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import * as v from "valibot"
import { afterEach, expect, it } from "vitest"
import { trackerIntrospection } from "../../test/fixtures/graphql-tracker.js"
import { commandPermissions } from "./permission-keys.js"
import { run } from "./program.js"
import { serviceApiPermissions } from "./service-api.js"
import { serviceApiCall } from "./service-api-call.js"
import type { ServiceApiManifest } from "./service-api-manifest.js"
import { settingsFor } from "./settings.js"
import { serviceApiCommand } from "./shared-command-exports.js"

const URL_ = "https://api.tracker.example/graphql"
const model = adaptGraphql(trackerIntrospection(), { url: URL_, scalars: { DateTime: { type: "string" } } })
// What a CLI's pnpm generate writes, read back.
const generated = generate(
  model,
  [manifestGenerator({ path: "manifest.ts" }), definitionsGenerator({ path: "definitions.ts" })],
  { banner: [], permissions: { group: "issues" } },
)
const constant = (path: string, name: string) => {
  const content = generated.find((one) => one.path === path)?.content ?? ""
  const start = content.indexOf("=", content.indexOf(`export const ${name}`)) + 1
  const end = content.indexOf("\n\nexport const", start)
  return JSON.parse(content.slice(start, end < 0 ? undefined : end))
}
const manifest: ServiceApiManifest = {
  servers: [{ url: URL_ }],
  securitySchemes: { key: { type: "apiKey", in: "header", name: "Authorization" } },
  security: [{ key: [] }],
  operations: constant("manifest.ts", "operations"),
}
const definitions = constant("definitions.ts", "definitions") as Record<string, SchemaNode>
const app = { command: "track", appName: "track-cli", envPrefix: "TRACK", description: "synthetic", version: "1.0.0" }

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Answers = Record<string, (call: GraphqlFakeCall) => GraphqlFakeAnswer>
const fakeOf = (answers: Answers = {}) =>
  graphqlFake({
    operations: manifest.operations,
    definitions,
    url: URL_,
    auth: { header: "Authorization", value: "key-1" },
    answers,
  })

// Copied from what valibotGenerator writes for the two operations; its file imports a types module a test lacks.
const SCHEMAS: Record<string, v.GenericSchema> = {
  IssueRequest: v.looseObject({ id: v.string() }),
  IssuesRequest: v.looseObject({
    first: v.optional(v.nullable(integer())),
    after: v.optional(v.nullable(v.string())),
    includeArchived: v.optional(v.nullable(v.boolean())),
  }),
}

const setup = (answers: Answers = {}) => {
  const root = mkdtempSync(join(tmpdir(), "graphql-api-"))
  roots.push(root)
  const env = { HOME: root, TRACK_STATE_DIR: join(root, "state"), TRACK_CONFIG_DIR: join(root, "config") }
  const fake = fakeOf(answers)
  mkdirSync(env.TRACK_CONFIG_DIR, { recursive: true })
  writeFileSync(
    join(env.TRACK_CONFIG_DIR, "config.json"),
    JSON.stringify({ profiles: { work: { permissions: { api: "allow" } } } }),
  )
  const api = {
    app,
    manifest,
    service: "Tracker",
    fetch: () => hostFetch({ hosts: ["api.tracker.example"], fetch: fake.fetch as typeof fetch }),
    token: () => "key-1",
    schemas: async () => SCHEMAS,
    definitions: async () => definitions,
  }
  const configuration = settingsFor(app, { permissions: commandPermissions(serviceApiPermissions(api)) })
  const definition = { app, configuration, commands: () => [serviceApiCommand({ ...api, configuration })] }
  const cli = async (argv: string[]) => {
    const streams = captureStreams()
    const code = await run(argv, definition, { streams, env, keyring: memoryKeyring(), tty: false })
    const out = streams.stdout.join("")
    const err = streams.stderr.join("")
    return {
      code,
      json: out.startsWith("{") ? JSON.parse(out) : undefined,
      error: err.startsWith("{") ? JSON.parse(err).error : undefined,
    }
  }
  return { cli, fake, root }
}

const issue = (id: string) => ({
  id,
  identifier: `T-${id}`,
  title: `issue ${id}`,
  description: null,
  priority: 1,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
  archivedAt: null,
  state: { id: "s1" },
  team: { id: "t1" },
  assignee: null,
})

it("a query is one POST of its document; flags join --body as variables, read by their schema", async () => {
  const { cli, fake } = setup({
    issues: () => ({ data: { nodes: [issue("a")], pageInfo: { hasNextPage: false, endCursor: null } } }),
  })
  const listed = await cli([
    "work",
    "api",
    "issues",
    "--first",
    "2",
    "--include-archived",
    "true",
    "--order-by",
    "updatedAt",
    "--body",
    '{"filter":{"updatedAt":{"gt":"2026-11-01T00:00:00Z"}}}',
    "--json",
  ])
  expect(fake.refusals).toEqual([])
  expect(listed.error?.message).toBeUndefined()
  expect(listed.json.item.nodes[0].identifier).toBe("T-a")
  expect(fake.refusals).toEqual([])
  expect(fake.calls[0]?.variables).toEqual({
    first: 2,
    includeArchived: true,
    orderBy: "updatedAt",
    filter: { updatedAt: { gt: "2026-11-01T00:00:00Z" } },
  })
  const one = await cli(["work", "api", "issue", "--id", "a", "--json"])
  expect(one.json.item).toMatchObject({ id: expect.any(String), state: { id: expect.any(String) } })
  expect(fake.calls[1]?.variables).toEqual({ id: "a" })
  expect(fake.refusals).toEqual([])
})

it("errors[] is a failure at HTTP 200, named by its code and never by the service's message", async () => {
  const { cli } = setup({
    issue: ({ variables }) => ({
      errors: [
        {
          message: "Entity not found: secret-title",
          extensions: { code: variables.id === "a" ? "FORBIDDEN" : "pii a@b.c in a code" },
        },
      ],
    }),
  })
  const failed = await cli(["work", "api", "issue", "--id", "a", "--json"])
  expect(failed.code).not.toBe(0)
  expect(failed.error.code).toBe("permission_error")
  expect(failed.error.message).not.toContain("secret-title")
  const odd = await cli(["work", "api", "issue", "--id", "b", "--json"])
  expect(odd.error.code).toBe("provider_error")
  expect(odd.error.message).not.toContain("a@b.c")
})

it("a write that errors[] does not show as undone is outcome_unknown; its flags stay out of the run's files", async () => {
  const marker = "secret-title-marker"
  const { cli, root } = setup({
    issueCreate: ({ variables }) =>
      (variables.input as { title: string }).title === "refused"
        ? { errors: [{ message: "x", extensions: { code: "BAD_USER_INPUT" } }] }
        : { data: { success: true }, errors: [{ message: "x", extensions: { code: "INTERNAL_SERVER_ERROR" } }] },
  })
  const create = (title: string) =>
    cli(["work", "api", "issue-create", "--input", JSON.stringify({ title, teamId: "t1" }), "--record", "--json"])
  expect((await create("refused")).error.code).toBe("validation_error")
  const unsure = await create(marker)
  expect(unsure.error.code).toBe("outcome_unknown")
  const files = filesUnder(root).filter((one) => !one.endsWith("config.json"))
  expect(files.some((one) => one.endsWith("run.json"))).toBe(true)
  for (const one of files) expect(readFileSync(one).includes(marker), one).toBe(false)
  const events = files.filter((one) => one.endsWith("events.jsonl")).map((one) => readFileSync(one, "utf8"))
  expect(events.join("")).toContain("mutation/issueCreate")
})

it("a flag of the wrong type or an undeclared variable is refused before anything is sent", async () => {
  const { cli, fake } = setup()
  for (const bad of ["many", "0x10", "1e1"])
    expect((await cli(["work", "api", "issues", "--first", bad, "--json"])).error.message).toContain(
      "takes a whole number",
    )
  expect((await cli(["work", "api", "issue", "--body", '{"id":"a","nope":1}', "--json"])).error.message).toContain(
    "has no variable nope",
  )
  expect(fake.calls).toEqual([])
})

it("--all follows pageInfo.endCursor through after, one document per page", async () => {
  const { cli, fake } = setup({
    issues: ({ variables }) =>
      variables.after === "c1"
        ? { data: { nodes: [issue("b")], pageInfo: { hasNextPage: false, endCursor: null } } }
        : { data: { nodes: [issue("a")], pageInfo: { hasNextPage: true, endCursor: "c1" } } },
  })
  const all = await cli(["work", "api", "issues", "--first", "1", "--all", "--json"])
  expect(all.error?.message).toBeUndefined()
  expect(JSON.stringify(all.json)).toContain("T-b")
  expect(fake.calls.map((one) => one.variables)).toEqual([{ first: 1 }, { first: 1, after: "c1" }])
})

it("serviceApiCall sends a source's own deeper selection and answers data.<field>", async () => {
  const fake = fakeOf({ issue: () => ({ data: { id: "a", state: { id: "s1", name: "Todo", type: "unstarted" } } }) })
  const call = serviceApiCall({
    manifest,
    service: "Tracker",
    fetch: hostFetch({ hosts: ["api.tracker.example"], fetch: fake.fetch as typeof fetch }),
    token: () => "key-1",
  })
  const answer = await call("issue", {
    path: {},
    query: {},
    headers: {},
    fields: { id: "a" },
    selection: "id state { id name type }",
  })
  expect(answer).toEqual({ id: "a", state: { id: "s1", name: "Todo", type: "unstarted" } })
  expect(fake.refusals).toEqual([])
  expect(fake.calls[0]?.query).toContain("state { id name type }")
})

it("the request schema sees the flags: a number flag passes, a missing required variable is refused unsent", async () => {
  const { cli, fake } = setup({
    issues: () => ({ data: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }),
  })
  expect((await cli(["work", "api", "issues", "--first", "2", "--json"])).error?.message).toBeUndefined()
  const missing = await cli(["work", "api", "issue", "--json"])
  expect(missing.error.code).toBe("validation_error")
  expect(missing.error.message).toContain("id")
  expect(fake.calls).toHaveLength(1)
})
