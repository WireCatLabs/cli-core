import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ServerContext } from "@modelcontextprotocol/server"
import { CliError } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { itemOf } from "../cli/envelope.js"
import type { Messenger } from "../cli/messenger/context.js"
import { findRun, listRuns, runsDirFor } from "../runs/run.js"
import { answered, BinaryResource, entryRunner, failed, Picture, type Registration } from "./tool.js"
import { attachmentsTools } from "./tools/attachments.js"

const READ_EFFECTS = { remote: "read", local: "read" } as const

describe("MCP result contract", () => {
  it("makes nested hidden text and object keys visible in both result formats, including error and image metadata", () => {
    const hidden = "a\u{e0041}\u0085\u202e\ufeffb"
    const visible = "a\\u{e0041}\\x85\\u202e\\ufeffb"
    const flag = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"
    const original = itemOf({ [hidden]: hidden, flag })
    const result = answered(original)
    expect(result.structuredContent).toMatchObject({ item: { [visible]: visible, flag } })
    expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify(result.structuredContent) })
    expect(original.item).toEqual({ [hidden]: hidden, flag })
    expect(JSON.stringify(original)).toContain(hidden)
    for (const value of [
      new Picture(new Uint8Array([1]), "image/png", itemOf({ text: hidden })),
      new BinaryResource("AQ==", "application/octet-stream", "attachment://fixture", itemOf({ text: hidden })),
    ]) {
      const response = answered(value)
      expect(response.structuredContent).toMatchObject({ item: { text: visible } })
      expect(response.content[1]).toEqual({ type: "text", text: JSON.stringify(response.structuredContent) })
    }
    expect(failed(new CliError("validation_error", hidden, { name: hidden })).structuredContent).toMatchObject({
      error: { message: visible, details: { name: visible } },
    })
  })
  it("advertises only envelopes that it can return as structured content", () => {
    const result = answered(itemOf({ id: "1" }))
    expect(result.structuredContent).toMatchObject({ item: { id: "1" } })
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }])
    expect(() => answered({ items: [], page: 1, limit: 0, hasMore: false })).toThrow("not an answer envelope")
    for (const value of [null, [], "invalid"]) expect(() => answered(value as never)).toThrow("must be an object")
  })
  it("counts the complete response, including duplicated structured content and image bytes", () => {
    expect(() => answered(itemOf({ text: "é".repeat(100) }), 200)).toThrow("byte limit")
    const image = new Picture(new Uint8Array(100), "image/png", itemOf({ chart: "synthetic" }))
    expect(answered(image, 0).structuredContent).toMatchObject({ item: { chart: "synthetic" } })
    expect(() => answered(image, 100)).toThrow("byte limit")
  })
  it("keeps explicit retry guidance and never shows the text of an unexpected failure", () => {
    expect(failed(new Error("synthetic private text")).structuredContent).toEqual({
      error: {
        code: "internal_error",
        reason: "command.crashed",
        message: "the command failed; this is a bug",
        retry: { safe: false },
      },
    })
    expect(
      failed(new CliError("outcome_unknown", "synthetic", { operation_id: "op-synthetic" })).structuredContent,
    ).toMatchObject({ error: { code: "outcome_unknown", details: { operation_id: "op-synthetic" } } })
    const limited = new CliError("rate_limited", "synthetic", { retryable: true, retry_after_ms: 1000 })
    expect(failed(limited, undefined, READ_EFFECTS).structuredContent).toMatchObject({
      error: { retry: { safe: true, after_ms: 1000 } },
    })
    expect(failed(limited, undefined, { remote: "write", local: "none" }).structuredContent).toMatchObject({
      error: { retry: { safe: false } },
    })
    expect(failed(limited, undefined, { remote: "read", local: "write" }).structuredContent).toMatchObject({
      error: { retry: { safe: true } },
    })
  })
})

it("refuses a root or picture metadata that is not an envelope, preserving nested ISO dates", () => {
  expect(() => answered(new Date())).toThrow("not an answer envelope")
  expect(() => answered(new Picture(new Uint8Array(), "image/png", []))).toThrow("not an answer envelope")
  expect(answered(itemOf({ at: new Date("2026-10-06T00:00:00.000Z") })).structuredContent).toMatchObject({
    item: { at: "2026-10-06T00:00:00.000Z" },
  })
})

it("returns large previews within their configured budget without lifting other tool limits", async () => {
  const messenger = { app: { command: "chat" } } as Messenger
  const definition = attachmentsTools(messenger).attachments_show
  if (!definition) throw new Error("attachment tool missing")
  const image = new Picture(new Uint8Array(4 * 1024 * 1024), "image/png", itemOf({ page: 1 }))
  const fixture = { ...definition, local: async () => image }
  const ctx = { mcpReq: { signal: new AbortController().signal } } as unknown as ServerContext
  const run = (env: NodeJS.ProcessEnv) =>
    entryRunner({ messenger, defaults: { settings: {}, env } } as unknown as Registration)
  const result = await run({})("attachments_show", fixture, { message: "m1", page: 1 }, ctx)
  expect(result.isError).not.toBe(true)
  expect(result.content[0]?.type).toBe("image")
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(4 * 1024 * 1024)
  const smaller = await run({ MESSAGING_PDF_PREVIEW_MAX_MIB: "1" })(
    "attachments_show",
    fixture,
    { message: "m1", page: 1 },
    ctx,
  )
  expect(smaller.isError).toBe(true)
  const ordinary = await run({})("attachments_show", fixture, { message: "m1" }, ctx)
  expect(ordinary.isError).toBe(true)
})

it("keeps partial MCP identifiers without payloads and honors explicitly disabled recording", async () => {
  const app = { command: "chat", appName: "chat-cli", envPrefix: "APP", description: "synthetic", version: "1.0.0" }
  const messenger = { app } as Messenger
  const definition = attachmentsTools(messenger).attachments_show
  if (!definition) throw new Error("attachment tool missing")
  const fixture = {
    ...definition,
    local: async () =>
      itemOf({
        complete: false,
        batch: {
          failed: 1,
          failures: [
            { id: "50", stage: "download", error: { code: "rate_limited", message: "synthetic private payload" } },
          ],
        },
      }),
  }
  const env = { APP_STATE_DIR: mkdtempSync(join(tmpdir(), "mcp-partial-record-")) }
  const ctx = { mcpReq: { signal: new AbortController().signal } } as unknown as ServerContext
  const registration = {
    messenger,
    defaults: { env, settings: { profile: "work", keepFailedRuns: false } },
  } as unknown as Registration
  await entryRunner(registration)("attachments_show", fixture, { message: "m1" }, ctx)
  expect(listRuns(runsDirFor(app, env))).toEqual([])
  registration.defaults.settings.keepFailedRuns = true
  await entryRunner(registration)("attachments_show", fixture, { message: "m1" }, ctx)
  const [metadata] = listRuns(runsDirFor(app, env))
  expect(metadata).toMatchObject({
    status: "partial",
    partial: { failures: [{ id: "50", errorCode: "rate_limited" }] },
  })
  const run = findRun(runsDirFor(app, env), metadata?.runId ?? "")
  if (!run) throw new Error("partial record missing")
  expect(readFileSync(join(run.dir, "run.json"), "utf8")).not.toContain("synthetic private payload")
})
