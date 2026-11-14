import { CliError, captureStreams } from "@wirecat/cli-base"
import type { ManifestOperation } from "@wirecat/cli-base/codegen"
import { hostFetch } from "@wirecat/cli-base/http"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { run } from "../program.js"
import { generatedApiCommand } from "./api.js"
import { type HttpApiExecutorOptions, httpApiExecutor, httpApiRequest } from "./api-http.js"
import { checkApiBody, checkApiParameter } from "./api-input.js"

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

const token: ManifestOperation = {
  id: "create-a-token",
  command: "create-a-token",
  binding: { kind: "http", method: "POST", path: "/v1/oauth/token" },
  effect: "write",
  tags: [],
  parameters: [],
  response: { confidence: "contract", schema: "Token", sensitive: true },
}

interface Sent {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

type Reply = (sent: Sent) => Response | Promise<Response>

interface Hooks {
  reply?: Reply
  write?: () => void
  read?: HttpApiExecutorOptions["read"]
  failure?: HttpApiExecutorOptions["failure"]
  path?: string
}

const call = async (
  words: string[],
  { reply = () => Response.json({ object: "page", id: "p1" }), write, read, failure, path }: Hooks = {},
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
          operations: [
            path ? { ...retrieve, binding: { kind: "http", method: "GET", path } } : retrieve,
            update,
            remove,
            upload,
            token,
          ],
          description: "every operation of the example API",
          checkParameter: (name, node, raw) => checkApiParameter(name, node, raw, {}),
          checkBody: (operation, text) => checkApiBody(operation, text, {}),
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
            ...(read ? { read } : {}),
            ...(failure ? { failure } : {}),
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

  it("refuses an operation that answers with a credential before sending it", async () => {
    const result = await call(["api", "--store-token", "personal", "create-a-token", "--json"])
    expect(result.code).toBe(2)
    expect(result.err).toContain("credential")
    expect(result.sent).toEqual([])
  })

  it("never makes a landed write look safe to repeat when its 2xx answer cannot be read", async () => {
    for (const reply of [
      () => new Response("<html>ok</html>", { status: 200 }),
      () => new Response("{}", { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } }),
    ]) {
      const result = await call(["api", "patch-page", "--page-id", "p1", "--body", "{}", "--json"], { reply })
      expect(result.err).toContain("outcome_unknown")
      expect(result.sent).toHaveLength(1)
    }
    const read = await call(["api", "retrieve-a-page", "--page-id", "p1", "--json"], {
      reply: () => new Response("not json", { status: 200 }),
    })
    expect(read.err).toContain("invalid_response")
    expect(read.err).not.toContain("not json")
    for (const reply of [() => new Response(null, { status: 204 }), () => new Response(null, { status: 200 })]) {
      const empty = await call(["api", "delete-a-block", "--block-id", "b1", "--json"], { reply })
      expect(empty.code).toBe(0)
      expect(JSON.parse(empty.out).item).toEqual({ operation_id: "op-1", result: {} })
    }
  })

  it("refuses a body that is not JSON, and a path template that does not start with one /", async () => {
    const text = await call(["api", "patch-page", "--page-id", "p1", "--body", "in_trash=true", "--json"])
    expect(text.code).toBe(2)
    expect(text.sent).toEqual([])
    expect(() =>
      httpApiRequest(update, { path: { page_id: "p1" }, query: {}, headers: {}, fields: {}, body: "x" }, "https://a.b"),
    ).toThrow(/JSON/)
    const relative = await call(["api", "retrieve-a-page", "--page-id", "p1", "--json"], { path: "//evil.example/x" })
    expect(relative.code).not.toBe(0)
    expect(relative.sent).toEqual([])
  })

  it("names the sign-in or the access on a 401 or 403, and a 4xx on a write is a plain refusal", async () => {
    const signIn = await call(["api", "retrieve-a-page", "--page-id", "p1", "--json"], {
      reply: () => new Response("{}", { status: 401 }),
    })
    expect(JSON.parse(signIn.err).error).toMatchObject({ code: "authentication_error", reason: "auth.failed" })
    const denied = await call(["api", "patch-page", "--page-id", "p1", "--body", "{}", "--json"], {
      reply: () => new Response("{}", { status: 403 }),
    })
    expect(JSON.parse(denied.err).error).toMatchObject({ code: "permission_error", reason: "access.denied" })
    const invalid = await call(["api", "patch-page", "--page-id", "p1", "--body", "{}", "--json"], {
      reply: () => Response.json({ code: "validation_error" }, { status: 400 }),
    })
    expect(JSON.parse(invalid.err).error.code).toBe("validation_error")
  })

  it("asks the failure hook for the service's refusal, but never for a write that failed on its side", async () => {
    const seen: unknown[] = []
    const failure: HttpApiExecutorOptions["failure"] = (status, answer) => {
      seen.push(answer)
      return new CliError("conflict", `the service's own reason for ${status}`)
    }
    const conflict = await call(["api", "patch-page", "--page-id", "p1", "--body", "{}", "--json"], {
      failure,
      reply: () => Response.json({ code: "conflict_error" }, { status: 409 }),
    })
    expect(JSON.parse(conflict.err).error.code).toBe("conflict")
    expect(seen).toEqual([{ code: "conflict_error" }])
    const broken = await call(["api", "patch-page", "--page-id", "p1", "--body", "{}", "--json"], {
      failure,
      reply: () => new Response("{}", { status: 503 }),
    })
    expect(JSON.parse(broken.err).error.code).toBe("outcome_unknown")
    expect(seen).toHaveLength(1)
  })

  it("runs a read inside the read hook, and refuses a redirect to an undeclared host", async () => {
    const scoped: string[] = []
    const read: HttpApiExecutorOptions["read"] = async (_command, operation, send) => {
      scoped.push(operation.id)
      return send()
    }
    expect((await call(["api", "retrieve-a-page", "--page-id", "p1", "--json"], { read })).code).toBe(0)
    expect(scoped).toEqual(["retrieve-a-page"])
    const moved = await call(["api", "retrieve-a-page", "--page-id", "p1", "--json"], {
      reply: () => new Response(null, { status: 302, headers: { location: "https://evil.example.org/steal" } }),
    })
    expect(moved.err).toContain("network.host-undeclared")
    expect(moved.sent.map((one) => new URL(one.url).host)).toEqual(["api.example.com"])
  })
})
