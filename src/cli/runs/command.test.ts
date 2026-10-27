import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { ENTITIES } from "../../entities/index.js"
import { listRuns, runsDirFor, startRun } from "../../runs/run.js"
import { run } from "../program.js"
import { runsCommand } from "./command.js"
import { runsSearchCommand } from "./search-command.js"

describe.each(["max", "tg"])("recorded run truncation for %s", (command) => {
  it.each(["pretty", "jsonl", "json"])("offers a supported continuation in %s", async (format) => {
    const state = mkdtempSync(join(tmpdir(), "runs-command-"))
    const env = { ...process.env, APP_STATE_DIR: state }
    const app = { command, appName: "app-cli", envPrefix: "APP", description: "Synthetic CLI", version: "1.0.0" }
    const dir = runsDirFor(app, env)
    for (let i = 0; i < 2; i++) {
      const item = startRun({
        runsDir: dir,
        profile: "synthetic",
        command: "chats list",
        service: "tg",
        cliVersion: app.version,
      })
      await item.finish("success")
    }
    const before = listRuns(dir).map((item) => item.runId)
    const streams = captureStreams()
    const argv = ["runs", "list", "--limit", "1", ...(format === "pretty" ? [] : [`--${format}`])]
    const code = await run(
      argv,
      { app, commands: () => [runsCommand(app), new Command("search").addCommand(runsSearchCommand(app))] },
      { streams, env, tty: format === "pretty" },
    )
    expect(code).toBe(0)
    expect(listRuns(dir).map((item) => item.runId)).toEqual(before)
    const stderr = streams.stderr.join("\n")
    if (format === "json") {
      expect(JSON.parse(streams.stdout[0] ?? "")).toMatchObject({
        page: { mode: "page", limit: 1, has_more: true, next_page: 2 },
        next: [{ step: "page.next", command: "runs list", args: { page: 2, limit: 1 } }],
      })
      expect(stderr).toBe("")
    } else {
      expect(stderr).toContain(`${command} runs list --page 2 --limit 1`)
      expect(streams.stdout).toHaveLength(format === "jsonl" ? 2 : 1)
    }
  })
})

it("shows every event of a run, and only its problems with --problems", async () => {
  const state = mkdtempSync(join(tmpdir(), "runs-command-"))
  const env = { ...process.env, APP_STATE_DIR: state }
  const app = { command: "tg", appName: "app-cli", envPrefix: "APP", description: "Synthetic CLI", version: "1.0.0" }
  const item = startRun({
    runsDir: runsDirFor(app, env),
    profile: "synthetic",
    command: "chats list",
    service: "tg",
    cliVersion: "1",
  })
  item.logger.info({ event: "provider.request", operation: "chats.list" })
  item.logger.info({ event: "provider.response", operation: "chats.list", outcome: "error", errorCode: "timeout" })
  item.logger.info({ event: "client.warning", code: "slow_answer" })
  await item.finish("failed", { errorCode: "timeout" })

  const show = async (...flags: string[]) => {
    const streams = captureStreams()
    await run(
      ["runs", "show", item.id, "--json", ...flags],
      { app, commands: () => [runsCommand(app), new Command("search").addCommand(runsSearchCommand(app))] },
      { streams, env },
    )
    return JSON.parse(streams.stdout[0] ?? "").item
  }

  const all = await show()
  expect(v.safeParse(ENTITIES["run.details"], all).success).toBe(true)
  expect(all).toMatchObject({ status: "failed", error_code: "timeout", event_count: 3 })
  expect(all.events.map((event: { event: string }) => event.event)).toEqual([
    "provider.request",
    "provider.response",
    "client.warning",
  ])
  expect((await show("--problems")).events).toMatchObject([
    { event: "provider.response", error_code: "timeout" },
    { event: "client.warning", code: "slow_answer" },
  ])
})

it("filters run metadata before paging and preserves the query in continuation", async () => {
  const state = mkdtempSync(join(tmpdir(), "runs-query-"))
  const env = { APP_STATE_DIR: state }
  const app = { command: "chat", appName: "app-cli", envPrefix: "APP", description: "Synthetic CLI", version: "1.0.0" }
  const dir = runsDirFor(app, env)
  for (const [day, profile, status] of [
    [1, "work", "failed"],
    [2, "work", "failed"],
    [3, "personal", "success"],
  ] as const) {
    const item = startRun({
      runsDir: dir,
      profile,
      command: "messages send",
      service: "chat",
      cliVersion: "1",
      now: () => new Date(`2026-10-0${day}T10:00:00Z`),
    })
    await item.finish(status, status === "failed" ? { errorCode: "timeout" } : {})
  }
  const before = listRuns(dir)
  const call = async (words: string[]) => {
    const streams = captureStreams()
    const code = await run(
      words,
      { app, commands: () => [runsCommand(app), new Command("search").addCommand(runsSearchCommand(app))] },
      { streams, env, tty: false },
    )
    return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
  }
  const query = "profile:work status:FAILED error_code:timeout"
  const first = await call(["runs", "list", query, "--limit", "1", "--json"])
  expect(first.code).toBe(0)
  const page = JSON.parse(first.stdout)
  expect(page.items).toHaveLength(1)
  expect(v.safeParse(ENTITIES.run, page.items[0]).success).toBe(true)
  expect(page.items[0]).toMatchObject({ profile: "work", status: "failed", started_at: "2026-10-02T10:00:00.000Z" })
  expect(page.next[0]).toMatchObject({ command: "runs list", args: { query, page: 2, limit: 1 } })
  const second = await call(["runs", "list", query, "--limit", "1", "--page", "2", "--json"])
  expect(JSON.parse(second.stdout).items[0].started_at).toBe("2026-10-01T10:00:00.000Z")
  expect(JSON.parse(second.stdout).page.has_more).toBe(false)
  const projected = await call(["runs", "list", 'command:"messages send"', "--json=run_id,status"])
  expect(projected.code).toBe(0)
  expect(
    JSON.parse(projected.stdout).items.every((row: object) => Object.keys(row).sort().join(",") === "run_id,status"),
  ).toBe(true)
  const search = await call(["search", "runs", "status:failed", "--json"])
  expect(search.code).toBe(0)
  for (const row of JSON.parse(search.stdout).items) expect(v.safeParse(ENTITIES["run.hit"], row).success).toBe(true)
  const path = await call(["runs", "path", page.items[0].run_id, "--json"])
  expect(v.safeParse(ENTITIES.run_location, JSON.parse(path.stdout).item).success).toBe(true)
  expect(listRuns(dir)).toEqual(before)
  const invalid = await call(["runs", "list", "runtime:node", "--json"])
  expect(invalid.code).toBe(2)
  expect(invalid.stderr).toContain("query.unsupported-field")
})

it("answers runs list and runs show in their declared shape for a run with its caller, and for an index-only success", async () => {
  const state = mkdtempSync(join(tmpdir(), "runs-command-"))
  const env = { ...process.env, APP_STATE_DIR: state }
  const app = { command: "tg", appName: "app-cli", envPrefix: "APP", description: "Synthetic CLI", version: "1.0.0" }
  const dir = runsDirFor(app, env)
  const called = startRun({
    runsDir: dir,
    command: "mcp chats list",
    service: "tg",
    cliVersion: app.version,
    context: {
      via: "mcp-http",
      agent: { kind: "mcp-client", session_id: "s-1", client: { name: "claude.ai", version: "1", id: "0a1b2c3d" } },
      mcp: { tool: "chats_list", request_id: "4", connection_id: "s-1", proxied: true },
    },
  })
  called.logger.info({ event: "request", operation: "chats.list", level: "wire", transport: "http", attempt: 2 })
  await called.finish("success", { eventsDropped: 3 })
  const quiet = startRun({ runsDir: dir, command: "chats list", service: "tg", cliVersion: app.version, lazy: true })
  await quiet.finish("success")
  const answer = async (argv: string[]) => {
    const streams = captureStreams()
    expect(await run(argv, { app, commands: () => [runsCommand(app)] }, { streams, env, tty: false })).toBe(0)
    return JSON.parse(streams.stdout[0] ?? "")
  }
  for (const item of (await answer(["runs", "list", "--json"])).items) v.parse(ENTITIES.run, item)
  for (const id of [called.id, quiet.id])
    v.parse(ENTITIES["run.details"], (await answer(["runs", "show", id, "--json"])).item)
})
