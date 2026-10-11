import { CliError, captureStreams } from "@wirecat/cli-base"
import type { ManifestOperation, SchemaNode } from "@wirecat/cli-base/codegen"
import { int64 } from "@wirecat/cli-base/codegen/runtime"
import { Command } from "commander"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { run } from "../program.js"
import { type ApiCommandInput, generatedApiCommand } from "./api.js"
import { apiJson, checkApiBody, checkApiParameter, readApiBody } from "./api-input.js"
import { prepareRpcApiBody } from "./api-rpc.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1" }
const request: SchemaNode = {
  type: "object",
  properties: {
    chat_id: { type: "union", of: [{ type: "integer", format: "int64" }, { type: "string" }] },
    photo: { type: "ref", ref: "File" },
    caption: { type: "string" },
    secret_token: { type: "string", sensitive: true },
    media: {
      type: "array",
      items: {
        type: "object",
        properties: { media: { type: "string", format: "file-reference" } },
        required: ["media"],
      },
    },
  },
  required: ["chat_id"],
}
const definitions = { Request: request, File: { type: "string", format: "binary" } } satisfies Record<
  string,
  SchemaNode
>
const schemas = {
  Request: v.looseObject({
    chat_id: v.union([int64(), v.string()]),
    photo: v.optional(v.pipe(v.string(), v.startsWith("attach://"))),
    caption: v.optional(v.string()),
    secret_token: v.optional(v.string()),
    media: v.optional(v.array(v.looseObject({ media: v.string() }))),
  }),
}
const rpc: ManifestOperation = {
  id: "sendPhoto",
  command: "send-photo",
  binding: { kind: "rpc", name: "sendPhoto" },
  effect: "write",
  tags: [],
  parameters: Object.entries(request.properties).map(([name, schema]) => ({
    name,
    schema,
    required: name === "chat_id",
    in: "body",
    ...(name === "secret_token" ? { sensitive: true } : {}),
  })),
  request: { schema: "Request", required: true, confidence: "contract" },
}
const http: ManifestOperation = {
  id: "getUpdates",
  command: "get-updates",
  binding: { kind: "http", method: "GET", path: "/updates" },
  effect: "read",
  tags: [],
  parameters: [{ name: "timeout", in: "query", required: false, schema: { type: "integer", minimum: 0 } }],
}
const input = (change: Partial<ApiCommandInput> = {}): ApiCommandInput => ({
  path: {},
  query: {},
  headers: {},
  fields: {},
  ...change,
})

const call = async (words: string[], operations: ManifestOperation[] = [rpc, http], before?: () => void) => {
  const streams = captureStreams()
  const calls: { operation: string; input: ApiCommandInput }[] = []
  const code = await run(
    words,
    {
      app,
      commands: () => [
        new Command("bot").addCommand(
          generatedApiCommand({
            operations,
            checkParameter: (name, node, raw) => checkApiParameter(name, node, raw, schemas),
            checkBody: (operation, text) => checkApiBody(operation, text, schemas),
            ...(before ? { before } : {}),
            execute: async (_command, operation, source) => {
              if (operation.binding.kind === "rpc") {
                const prepared = prepareRpcApiBody(operation, source, definitions)
                checkApiBody(operation, prepared.text, schemas)
              }
              calls.push({ operation: operation.id, input: source })
              streams.data("true\n")
            },
          }),
        ),
      ],
    },
    { streams, tty: false },
  )
  return { code, calls, out: streams.stdout.join(""), err: streams.stderr.join("") }
}

describe("the shared native API command", () => {
  it("accepts RPC body fields or a JSON body, and isolates native poll timeout from the command deadline", async () => {
    expect(
      (await call(["bot", "api", "send-photo", "--chat-id", "9007199254740993", "--caption", "example", "--json"]))
        .code,
    ).toBe(0)
    expect((await call(["bot", "api", "send-photo", "--body", '{"chat_id":1}', "--json"])).out).toBe("true\n")
    const result = await call(["bot", "api", "get-updates", "--poll-timeout", "7", "--timeout", "1s", "--json"])
    expect(result.calls[0]?.input.query).toEqual({ timeout: "7" })
    expect(result.code).toBe(0)
  })

  it("checks parameters and required body fields before executing, without echoing invalid values", async () => {
    const invalid = await call(["bot", "api", "get-updates", "--poll-timeout", "private-value", "--json"])
    expect(invalid.code).toBe(2)
    expect(invalid.calls).toEqual([])
    expect(invalid.err).not.toContain("private-value")
    expect((await call(["bot", "api", "send-photo", "--body", '{"caption":"private-value"}', "--json"])).calls).toEqual(
      [],
    )
    const denied = await call(["bot", "api", "send-photo", "--body", "-", "--json"], [rpc], () => {
      throw new CliError("permission_error", "denied")
    })
    expect(denied.code).toBe(5)
    expect(denied.calls).toEqual([])
  })

  it("does not offer sensitive field flags", async () => {
    const result = await call(["bot", "api", "send-photo", "--secret-token", "private-value", "--json"])
    expect(result.code).not.toBe(0)
    expect(result.calls).toEqual([])
  })

  it("requires an explicit destination only for credential-returning methods before executing", async () => {
    const credential: ManifestOperation = {
      ...http,
      id: "getManagedBotToken",
      command: "get-managed-bot-token",
      response: { confidence: "contract", sensitive: true },
    }
    const missing = await call(["bot", "api", "get-managed-bot-token", "--json"], [credential])
    expect(missing.code).toBe(2)
    expect(missing.calls).toEqual([])
    const accepted = await call(
      ["bot", "api", "get-managed-bot-token", "--store-token", "managed", "--json"],
      [credential],
    )
    expect(accepted.code).toBe(0)
    expect(accepted.calls[0]?.input.tokenProfile).toBe("managed")
    const irrelevant = await call(["bot", "api", "get-updates", "--store-token", "managed", "--json"])
    expect(irrelevant.code).toBe(2)
    expect(irrelevant.calls).toEqual([])
  })

  it("keeps the existing body file/stdin selection and refuses conflicting sources before reading", () => {
    const reads: (string | number)[] = []
    const read = (path: string | number) => {
      reads.push(path)
      return "{}"
    }
    expect(readApiBody({ body: "-" }, read)).toBe("{}")
    expect(readApiBody({ bodyFile: "-" }, read)).toBe("{}")
    expect(readApiBody({ bodyFile: "fixture.json" }, read)).toBe("{}")
    expect(reads).toEqual([0, 0, "fixture.json"])
    expect(() => readApiBody({ body: "{}", bodyFile: "fixture.json" }, read)).toThrow(/both given/)
    expect(reads).toHaveLength(3)
  })
})

describe("RPC wire preparation", () => {
  it("keeps integer digits exact and plans only schema-declared file references without reading files", () => {
    const prepared = prepareRpcApiBody(
      rpc,
      input({
        fields: {
          chat_id: "9007199254740993",
          photo: "@fixture.png",
          caption: "@literal-text",
          media: '[{"media":"@clip.mp4"}]',
        },
      }),
      definitions,
    )
    expect(prepared.files).toEqual([
      { field: "_api_file_0", path: "fixture.png" },
      { field: "_api_file_1", path: "clip.mp4" },
    ])
    expect(prepared.text).toContain('"chat_id":9007199254740993')
    expect(prepared.value.caption).toBe("@literal-text")
    expect(checkApiBody(rpc, prepared.text, schemas)).toBe(prepared.text)
    expect(apiJson(prepared.value)).toBe(prepared.text)
  })

  it("refuses duplicate values, dangling multipart references, missing schema metadata and credentials in argv", () => {
    expect(() =>
      prepareRpcApiBody(rpc, input({ body: '{"chat_id":1}', fields: { chat_id: "1" } }), definitions),
    ).toThrow(/both/)
    expect(() =>
      prepareRpcApiBody(rpc, input({ body: '{"chat_id":1,"photo":"attach://missing"}' }), definitions),
    ).toThrow(/no corresponding file/)
    expect(() => prepareRpcApiBody(rpc, input(), {})).toThrow(/schema is missing/)
    expect(() =>
      prepareRpcApiBody(
        rpc,
        input({ body: '{"chat_id":1,"secret_token":"private-value"}', bodySource: "argument" }),
        definitions,
      ),
    ).toThrow(/stdin/)
    const protectedInput = prepareRpcApiBody(
      rpc,
      input({ body: '{"chat_id":1,"secret_token":"private-value"}', bodySource: "stdin" }),
      definitions,
    )
    expect(protectedInput.secrets).toEqual(["private-value"])
  })
})
