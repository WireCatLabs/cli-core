import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, captureStreams, errorObjectOf } from "@wirecat/cli-base"
import { BASE_REASONS, defineReasons } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { run } from "../cli/program.js"
import { CORE_DETAILS, CORE_REASONS } from "../index.js"
import { failed } from "../mcp/tool.js"
import { DETAILS, failureContext, REASONS } from "./reasons.js"

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
        ? [join(dir, entry.name)]
        : [],
  )

const app = { appName: "app", command: "app", envPrefix: "APP", description: "synthetic", version: "1.0.0" }

const failing = (error: unknown) => ({
  app,
  commands: () => [
    new Command("item").action(() => {
      throw error
    }),
  ],
})

describe("error reasons", () => {
  it("retains the tag-preview budget reason and selected dependency table", () => {
    const error = new CliError("validation_error", "tag preview exceeds its budget", {
      reason: "vocabulary.consolidation-over-budget",
      table: "links",
    })
    const object = errorObjectOf(error, failureContext())
    expect(object.error).toMatchObject({ reason: "vocabulary.consolidation-over-budget", details: { table: "links" } })
    expect(failed(error).structuredContent).toEqual(object)
  })

  it("registers every dotted reason the source raises", () => {
    const known = new Set([...REASONS, ...BASE_REASONS].map((entry) => entry.reason))
    const raised = sources(join(import.meta.dirname, "..")).flatMap((path) =>
      [
        ...readFileSync(path, "utf8").matchAll(/(?:reason: |queryError\(|fail\([^)]*, )"([a-z][a-z-]*\.[a-z.-]+)"/g),
      ].map((match) => match[1] ?? ""),
    )
    expect(raised.length).toBeGreaterThan(30)
    expect([...new Set(raised.filter((reason) => !known.has(reason)))]).toEqual([])
  })

  it.each(REASONS.map((entry) => [entry.reason, entry]))(
    "%s renders one object on the CLI and MCP",
    async (_, entry) => {
      const error = new CliError(entry.code as "validation_error", "synthetic failure", { reason: entry.reason })
      const object = errorObjectOf(error, { reasons: REASONS, details: DETAILS })
      expect(object.error.reason).toBe(entry.reason)
      expect(failed(error).structuredContent).toEqual(object)
      const streams = captureStreams()
      await run(["item", "--json", "--no-record"], failing(error), { streams, tty: false, env: process.env })
      expect(JSON.parse(streams.stderr[0] ?? "")).toEqual(object)
    },
  )

  it("shows a person no cause or stack, and --debug the whole record", async () => {
    const error = new CliError("configuration_error", "store is locked", { cause: "SQLITE_BUSY near private text" })
    const plain = captureStreams()
    await run(["item", "--no-record"], failing(error), { streams: plain, tty: true, env: process.env })
    expect(plain.stderr).toEqual(["✗ store is locked"])
    const debug = captureStreams()
    await run(["item", "--debug", "--no-record"], failing(error), { streams: debug, tty: true, env: process.env })
    const [line, ...record] = (debug.stderr[0] ?? "").split("\n")
    expect(line).toBe("✗ store is locked")
    expect(JSON.parse(record.join("\n"))).toMatchObject({
      severity: "error",
      command: "item",
      attributes: { code: "configuration_error", cause: "SQLITE_BUSY near private text" },
    })
  })

  it("keeps an app's own reason and detail keys on the CLI and MCP alike", async () => {
    const errors = {
      reasons: defineReasons([
        { reason: "chat.migrated", code: "not_found", message: "the group became a supergroup", details: [] },
      ]),
      details: ["migrated_chat_id"],
    }
    const error = new CliError("not_found", "the group moved", {
      reason: "chat.migrated",
      migrated_chat_id: "-1001",
      provider_error: "CHAT_MIGRATED",
    })
    const streams = captureStreams()
    await run(
      ["item", "--json", "--no-record"],
      { ...failing(error), app: { ...app, errors } },
      {
        streams,
        tty: false,
        env: process.env,
      },
    )
    const printed = JSON.parse(streams.stderr[0] ?? "")
    expect(printed.error).toMatchObject({
      reason: "chat.migrated",
      details: { migrated_chat_id: "-1001", provider_error: "CHAT_MIGRATED" },
    })
    expect(failed(error, errors).structuredContent).toEqual(printed)
    expect(failed(error).structuredContent).toMatchObject({ error: { reason: "item.not-found" } })
  })

  it("keeps cli-core's reasons and details for an app that registers only its own", () => {
    const own = defineReasons([
      { reason: "sign-in.expired", code: "authentication_error", message: "sign in again", details: [] },
    ])
    const error = new CliError("validation_error", "a memory needs its scope", {
      reason: "memory.scope-required",
      candidates: ["project:a"],
    })
    expect(errorObjectOf(error, { reasons: own }).error).not.toMatchObject({ reason: "memory.scope-required" })
    expect(errorObjectOf(error, failureContext({ reasons: own })).error).toMatchObject({
      reason: "memory.scope-required",
      details: { candidates: ["project:a"] },
    })
    expect(CORE_REASONS).toBe(REASONS)
    expect(CORE_DETAILS).toBe(DETAILS)
  })

  it("refuses an app detail key that is not snake_case", () => {
    expect(() => failureContext({ details: ["migratedChatId"] })).toThrow(/snake_case: migratedChatId/)
  })
})

it("keeps the keys a task error names in the JSON a CLI prints", () => {
  const context = { reasons: CORE_REASONS, details: CORE_DETAILS }
  const subtasks = new CliError("validation_error", "HRB-1 has subtasks", {
    reason: "task.has-subtasks",
    subtasks: ["HRB-2"],
  })
  expect(errorObjectOf(subtasks, context).error.details).toEqual({ subtasks: ["HRB-2"] })
  const subtask = new CliError("validation_error", "HRB-2 is a subtask", { reason: "task.is-subtask", parent: "HRB-1" })
  expect(errorObjectOf(subtask, context).error.details).toEqual({ parent: "HRB-1" })
})
