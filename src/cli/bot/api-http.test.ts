import { CliError, captureStreams } from "@wirecat/cli-base"
import type { ManifestOperation } from "@wirecat/cli-base/codegen"
import { hostFetch } from "@wirecat/cli-base/http"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { run } from "../program.js"
import { generatedApiCommand } from "./api.js"
import { httpApiExecutor, httpApiRequest } from "./api-http.js"
import { checkApiParameter } from "./api-input.js"

const app = { command: "pages", appName: "pages-cli", envPrefix: "PAGES", description: "A test", version: "1" }

const retrieve: ManifestOperation = {
  id: "retrieve-a-page",
  command: "retrieve-a-page",
  binding: { kind: "http", method: "GET", path: "/v1/pages/{page_id}" },
  effect: "read",
  tags: [],
  parameters: [
    { name: "page_id", in: "path", required: true, schema: { type: "string" } },
    { name: "filter_properties", in: "query", required: false, schema: { type: "array", items: { type: "string" } } },
  ],
}
const update: ManifestOperation = {
  id: "patch-page",
  command: "patch-page",
  binding: { kind: "http", method: "PATCH", path: "/v1/pages/{page_id}" },
  effect: "write",
  tags: [],
  parameters: [{ name: "page_id", in: "path", required: true, schema: { type: "string" } }],
  request: { required: true, confidence: "contract" },
}
const remove: ManifestOperation = {
  id: "delete-a-block",
  command: "delete-a-block",
  binding: { kind: "http", method: "DELETE", path: "/v1/blocks/{block_id}" },
  effect: "destructive",
  tags: [],
  parameters: [{ name: "block_id", in: "path", required: true, schema: { type: "string" } }],
}
const upload: ManifestOperation = {
  id: "upload-file",
  command: "upload-file",
  binding: { kind: "http", method: "POST", path: "/v1/file_uploads/{id}/send" },
  effect: "write",
  tags: [],
  parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
  request: { required: true, confidence: "contract", contentType: "multipart/form-data" },
}

interface Sent {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

type Reply = (sent: Sent) => Response | Promise<Response>

const call = async (
  words: string[],
  { reply = () => Response.json({ object: "page", id: "p1" }), write }: { reply?: Reply; write?: () => void } = {},
) => {
  const streams = captureStreams()
  const sent: Sent[] = []
  const journal: string[] = []
  const strict: typeof fetch = async (input, init) => {
    const one: Sent = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    }
    sent.push(one)
    return reply(one)
  }
  const code = await run(
    words,
    {
      app,
      commands: () => [
        generatedApiCommand({
          operations: [retrieve, update, remove, upload],
          description: "every operation of the example API",
          checkParameter: (name, node, raw) => checkApiParameter(name, node, raw, {}),
          execute: httpApiExecutor({
            service: "Example",
            baseUrl: "https://api.example.com",
            fetch: () => hostFetch({ hosts: ["api.example.com"], fetch: strict }),
            headers: () => ({ authorization: "Bearer secret-token", "Example-Version": "2026-03-11" }),
            write: async (_command, operation, send) => {
              write?.()
              journal.push(operation.id)
              return { operation_id: "op-1", result: await send() }
            },
          }),
        }),
      ],
    },
    { streams, tty: false },
  )
  return { code, sent, journal, out: streams.stdout.join(""), err: streams.stderr.join("") }
}

describe("the generated HTTP API executor", () => {
  it("fills the path, repeats an array query and sends the caller's headers over the host-checked fetch", async () => {
    const result = await call([
      "api",
      "retrieve-a-page",
      "--page-id",
      "a/b",
      "--filter-properties",
      "title, status",
      "--json",
    ])
    expect(result.code).toBe(0)
    expect(result.sent).toEqual([
      {
        method: "GET",
        url: "https://api.example.com/v1/pages/a%2Fb?filter_properties=title&filter_properties=status",
        headers: { accept: "application/json", authorization: "Bearer secret-token", "example-version": "2026-03-11" },
      },
    ])
    expect(JSON.parse(result.out).item).toEqual({ object: "page", id: "p1" })
    expect(result.journal).toEqual([])
  })

  it("sends a write's JSON body only through the caller's guarded write", async () => {
    const result = await call(["api", "patch-page", "--page-id", "p1", "--body", '{"in_trash":true}', "--json"])
    expect(result.code).toBe(0)
    expect(result.journal).toEqual(["patch-page"])
    expect(result.sent[0]).toMatchObject({ method: "PATCH", body: '{"in_trash":true}' })
    expect(result.sent[0]?.headers["content-type"]).toBe("application/json")
    expect(JSON.parse(result.out).item.operation_id).toBe("op-1")
  })

  it("sends nothing when the guard refuses, or under --dry-run", async () => {
    const refused = await call(["api", "delete-a-block", "--block-id", "b1", "--json"], {
      write: () => {
        throw new CliError("permission_error", "this asks; pass --yes")
      },
    })
    expect(refused.code).toBe(5)
    expect(refused.sent).toEqual([])
    const preview = await call(["personal", "api", "delete-a-block", "--block-id", "b1", "--dry-run", "--json"])
    expect(preview.code).toBe(0)
    expect(preview.sent).toEqual([])
    expect(preview.journal).toEqual([])
  })

  it("refuses an id that would reach another endpoint, and a body it cannot send, before any request", async () => {
    for (const words of [
      ["api", "retrieve-a-page", "--page-id", "..", "--json"],
      ["api", "upload-file", "--id", "f1", "--body", "{}", "--json"],
    ]) {
      const result = await call(words)
      expect(result.code).toBe(2)
      expect(result.sent).toEqual([])
    }
    expect(() =>
      httpApiRequest(retrieve, { path: { page_id: "." }, query: {}, headers: {}, fields: {} }, "https://a.example"),
    ).toThrow(/refused/)
  })

  it("never repeats the service's own error text, and reports a failed write as an unknown outcome", async () => {
    const refusal = () => Response.json({ code: "object_not_found", message: "secret-page-title" }, { status: 404 })
    const missing = await call(["api", "retrieve-a-page", "--page-id", "p1", "--json"], { reply: refusal })
    expect(missing.code).not.toBe(0)
    expect(missing.err).toContain("not_found")
    expect(`${missing.out}${missing.err}`).not.toContain("secret-page-title")
    const failed = await call(["api", "patch-page", "--page-id", "p1", "--body", "{}", "--json"], {
      reply: () => new Response("busy", { status: 502 }),
    })
    expect(failed.err).toContain("outcome_unknown")
    const lost = await call(["api", "patch-page", "--page-id", "p1", "--body", "{}", "--json"], {
      reply: () => {
        throw new TypeError("socket closed")
      },
    })
    expect(lost.err).toContain("outcome_unknown")
    const slow = await call(["api", "retrieve-a-page", "--page-id", "p1", "--json"], {
      reply: () => new Response("{}", { status: 429, headers: { "retry-after": "3" } }),
    })
    expect(slow.err).toContain("rate_limited")
  })

  it("never reaches an undeclared host", async () => {
    const streams = captureStreams()
    const code = await run(
      ["api", "retrieve-a-page", "--page-id", "p1", "--json"],
      {
        app,
        commands: () => [
          new Command("unused"),
          generatedApiCommand({
            operations: [retrieve],
            checkParameter: () => undefined,
            execute: httpApiExecutor({
              service: "Example",
              baseUrl: "https://elsewhere.example.org",
              fetch: () =>
                hostFetch({
                  hosts: ["api.example.com"],
                  fetch: () => {
                    throw new Error("reached the network")
                  },
                }),
              headers: () => ({}),
              write: (_command, _operation, send) => send(),
            }),
          }),
        ],
      },
      { streams, tty: false },
    )
    expect(code).not.toBe(0)
    expect(streams.stderr.join("")).toContain("network.host-undeclared")
  })
})
