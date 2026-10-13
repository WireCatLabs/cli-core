import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, captureStreams, errorObjectOf } from "@wirecat/cli-base"
import { BASE_REASONS } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { failed } from "../mcp/tool.js"
import { run } from "./program.js"
import { DETAILS, REASONS } from "./reasons.js"

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
})
