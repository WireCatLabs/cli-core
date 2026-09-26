import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as v from "valibot"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  type ApiModel,
  CodegenError,
  coverageGenerator,
  generate,
  manifestGenerator,
  typesGenerator,
  valibotGenerator,
  writeArtifacts,
} from "./index.js"

const lossless = (value: string) => ({ isLosslessNumber: true as const, value })

const model = (changes: Partial<ApiModel> = {}): ApiModel => ({
  source: { kind: "openapi", version: "0.0.1" },
  schemas: [
    {
      id: "User",
      schema: {
        type: "object",
        properties: {
          user_id: { type: "integer", format: "int64" },
          name: { type: "string", minLength: 1, maxLength: 5 },
          username: { type: "string", nullable: true, pattern: "^[a-z]+$" },
          age: { type: "integer", format: "int32", minimum: 0 },
          tags: { type: "array", items: { type: "string" }, uniqueItems: true },
        },
        required: ["user_id", "name"],
      },
    },
    { id: "ChatType", schema: { type: "string", enum: ["dialog", "chat"] } },
    {
      id: "Update",
      schema: {
        type: "object",
        properties: { update_type: { type: "string" }, timestamp: { type: "integer", format: "int64" } },
        required: ["update_type", "timestamp"],
      },
      discriminator: {
        property: "update_type",
        mapping: { bot_started: "BotStartedUpdate", chat_seen: "ChatUpdate", ping: "PingUpdate" },
      },
    },
    { id: "PingUpdate", schema: { type: "allOf", of: [{ type: "ref", ref: "Update" }] } },
    {
      id: "BotStartedUpdate",
      schema: {
        type: "allOf",
        of: [
          { type: "ref", ref: "Update" },
          { type: "object", properties: { user: { type: "ref", ref: "User" } }, required: ["user"] },
        ],
      },
    },
    {
      id: "ChatUpdate",
      schema: {
        type: "allOf",
        of: [
          { type: "ref", ref: "Update" },
          {
            type: "object",
            properties: { chat_type: { type: "allOf", of: [{ type: "ref", ref: "ChatType" }], nullable: true } },
            required: [],
          },
        ],
      },
    },
  ],
  operations: [
    {
      id: "getMyInfo",
      binding: { kind: "http", method: "GET", path: "/me" },
      tags: ["bots"],
      parameters: [],
      response: { confidence: "contract", required: true, schema: { type: "ref", ref: "User" } },
      effect: "read",
      source: { location: "#/paths/~1me/get" },
    },
    {
      id: "getUpdates",
      binding: { kind: "http", method: "GET", path: "/updates" },
      tags: [],
      parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", maximum: 1000 } }],
      response: {
        confidence: "contract",
        required: true,
        schema: {
          type: "object",
          properties: { updates: { type: "array", items: { type: "ref", ref: "Update" } } },
          required: ["updates"],
        },
      },
      effect: "read",
      source: { location: "#/paths/~1updates/get" },
    },
    {
      id: "answerOnCallback",
      binding: { kind: "http", method: "POST", path: "/answers" },
      tags: [],
      parameters: [],
      source: { location: "#/paths/~1answers/post" },
    },
  ],
  ...changes,
})

const overrides = { answerOnCallback: { effect: "write" as const, reason: "a POST that changes a message" } }
const banner = ["Source: spec/test.yaml", "Run: pnpm test"]

const generators = [
  typesGenerator({ path: "types.ts" }),
  valibotGenerator({ path: "schemas.ts", typesImport: "./types.js", runtimeImport: "../runtime.js" }),
  manifestGenerator({ path: "manifest.ts", coreImport: "../index.js" }),
  coverageGenerator({ path: "coverage.md", title: "Coverage", command: (operation) => `x api ${operation.command}` }),
]

const problemsOf = (run: () => unknown): readonly string[] => {
  try {
    run()
  } catch (error) {
    if (error instanceof CodegenError) return error.problems
    throw error
  }
  return []
}

describe("generate", () => {
  it("refuses an operation nobody classified as a read or a write", () => {
    expect(problemsOf(() => generate(model(), generators, { banner }))).toEqual([
      'operation "answerOnCallback" is not classified as read, write or destructive',
    ])
  })

  it("refuses an override that matches no operation", () => {
    const stale = { ...overrides, sendMessage: { effect: "write" as const, reason: "renamed upstream" } }
    expect(problemsOf(() => generate(model(), generators, { banner, overrides: stale }))).toEqual([
      'override "sendMessage" matches no operation — stale, or the id changed',
    ])
  })

  it("refuses colliding ids, colliding calls and unknown references instead of dropping one", () => {
    const base = model()
    const [first] = base.operations
    if (!first) throw new Error("fixture")
    const broken = model({
      operations: [...base.operations, { ...first }, { ...first, id: "again" }],
      schemas: [...base.schemas, { id: "Broken", schema: { type: "ref", ref: "Missing" } }],
    })
    expect(problemsOf(() => generate(broken, generators, { banner, overrides }))).toEqual([
      'two operations share the id "getMyInfo"',
      "two operations are both GET /me",
      'two operations both become the command "get-my-info"',
      'schema "Broken" refers to unknown schema "Missing"',
    ])
  })

  it("refuses two ids that would become one command, one type name or one flag", () => {
    const base = model()
    const [first] = base.operations
    const [user] = base.schemas
    if (!first || !user) throw new Error("fixture")
    const clashing = model({
      operations: [
        ...base.operations,
        {
          ...first,
          id: "get-my-info",
          binding: { kind: "http", method: "GET", path: "/me2" },
          parameters: [
            { name: "chat_id", in: "query", required: false, schema: { type: "string" } },
            { name: "chat_id", in: "path", required: true, schema: { type: "string" } },
          ],
        },
      ],
      schemas: [...base.schemas, { ...user, id: "user" }],
    })
    expect(problemsOf(() => generate(clashing, generators, { banner, overrides }))).toEqual([
      'two operations both become the command "get-my-info"',
      'two schemas both become the name "User"',
      'operation "get-my-info" has two parameters named "chat_id"',
    ])
  })

  it("writes the same bytes every time, under a banner with no date in it", () => {
    const once = generate(model(), generators, { banner, overrides })
    const twice = generate(model(), generators, { banner, overrides })
    expect(once).toEqual(twice)
    expect(once[0]?.content.startsWith("// GENERATED. DO NOT EDIT.\n// Source: spec/test.yaml\n")).toBe(true)
    expect(once.find((artifact) => artifact.path === "coverage.md")?.content).toContain(
      "| `answerOnCallback` | `POST /answers` | `x api answer-on-callback` | write |",
    )
  })
})

describe("writeArtifacts", () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".tmp-write-"))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("reports a stale file under --check and writes nothing, then writes it for real", () => {
    const artifacts = [{ path: "nested/a.ts", content: "export {}\n" }]
    expect(writeArtifacts(artifacts, { root, check: true })).toEqual(["nested/a.ts"])
    expect(() => readFileSync(join(root, "nested/a.ts"))).toThrow()
    expect(writeArtifacts(artifacts, { root })).toEqual(["nested/a.ts"])
    expect(writeArtifacts(artifacts, { root, check: true })).toEqual([])
  })
})

describe("generated schemas", () => {
  let schemas: Record<string, v.GenericSchema>
  let root: string

  beforeAll(async () => {
    root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".tmp-schemas-"))
    for (const artifact of generate(model(), generators, { banner, overrides })) {
      writeFileSync(join(root, artifact.path), artifact.content)
    }
    ;({ schemas } = await import(join(root, "schemas.ts")))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("compiles: every schema's output matches its generated type", () => {
    const config = {
      extends: "../../../tsconfig.json",
      compilerOptions: { noEmit: true, composite: false, declaration: false, declarationMap: false, rootDir: "../.." },
      include: ["types.ts", "schemas.ts", "manifest.ts"],
    }
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(config))
    const tsc = join(root, "../../../node_modules/.bin", process.platform === "win32" ? "tsc.cmd" : "tsc")
    expect(() => execFileSync(tsc, ["-p", join(root, "tsconfig.json")], { stdio: "pipe" })).not.toThrow()
  }, 30_000)

  const parse = (name: string, input: unknown) => v.safeParse(schemas[name] as v.GenericSchema, input)

  it("keeps a 64-bit id above 2^53 exact, as a decimal string", () => {
    const result = parse("User", { user_id: lossless("9007199254740993"), name: "ann" })
    expect(result.success && result.output).toMatchObject({ user_id: "9007199254740993" })
  })

  it("fails an int32 that does not fit a JS number, instead of rounding it", () => {
    expect(parse("User", { user_id: lossless("1"), name: "ann", age: lossless("9007199254740993") }).success).toBe(
      false,
    )
  })

  it("keeps the source's constraints: length, pattern, minimum, unique items, enum", () => {
    const valid = { user_id: 1, name: "ann" }
    expect(parse("User", valid).success).toBe(true)
    expect(parse("User", { ...valid, name: "" }).success).toBe(false)
    expect(parse("User", { ...valid, username: "Ann" }).success).toBe(false)
    expect(parse("User", { ...valid, username: null }).success).toBe(true)
    expect(parse("User", { ...valid, age: -1 }).success).toBe(false)
    expect(parse("User", { ...valid, tags: ["a", "a"] }).success).toBe(false)
    expect(parse("ChatType", "channel").success).toBe(false)
  })

  it("lets fields it has never seen through", () => {
    const result = parse("User", { user_id: 1, name: "ann", added_later: true })
    expect(result.success && result.output).toMatchObject({ added_later: true })
  })

  it("resolves a discriminated update to its subtype and keeps the discriminator", () => {
    const update = {
      update_type: "bot_started",
      timestamp: lossless("1758888888000"),
      user: { user_id: lossless("9007199254740993"), name: "ann" },
    }
    const result = parse("Update", update)
    expect(result.success && result.output).toEqual({
      update_type: "bot_started",
      timestamp: "1758888888000",
      user: { user_id: "9007199254740993", name: "ann" },
    })
    expect(parse("Update", { ...update, update_type: "chat_seen", chat_type: "chat" }).success).toBe(true)
    expect(parse("Update", { ...update, update_type: "unknown" }).success).toBe(false)
    expect(parse("BotStartedUpdate", { ...update, update_type: "chat_seen" }).success).toBe(false)
    expect(parse("Update", { update_type: "ping", timestamp: 1 }).success).toBe(true)
    expect(parse("PingUpdate", { update_type: "bot_started", timestamp: 1 }).success).toBe(false)
  })

  it("gives an inline response body a schema of its own", () => {
    expect(parse("GetUpdatesResponse", { updates: [] }).success).toBe(true)
  })
})
