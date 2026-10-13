import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { run } from "../program.js"
import { runsCommand } from "./command.js"
import { listRuns, runsDirFor, startRun } from "./run.js"

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
      { app, commands: () => [runsCommand(app)] },
      { streams, env, tty: format === "pretty" },
    )
    expect(code).toBe(0)
    expect(listRuns(dir).map((item) => item.runId)).toEqual(before)
    const stderr = streams.stderr.join("\n")
    expect(stderr).not.toContain("--page")
    if (format === "json") {
      expect(JSON.parse(streams.stdout[0] ?? "")).toMatchObject({ page: 1, limit: 1, hasMore: true })
      expect(stderr).toBe("")
    } else {
      expect(stderr).toContain("--limit")
      expect(stderr).toContain("more recorded runs")
      expect(streams.stdout).toHaveLength(1)
    }
  })
})

it("shows a run's failures and leaves the rest to -v", async () => {
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
  item.logger.info({ event: "request", operation: "chats.list" })
  item.logger.info({ event: "response", operation: "chats.list", outcome: "error", errorCode: "timeout" })
  item.logger.info({ event: "warning", code: "slow_answer" })
  await item.finish("failed", { errorCode: "timeout" })

  const streams = captureStreams()
  await run(["runs", "show", item.id, "--json"], { app, commands: () => [runsCommand(app)] }, { streams, env })

  expect(JSON.parse(streams.stdout[0] ?? "")).toMatchObject({
    status: "failed",
    errorCode: "timeout",
    eventCount: 3,
    events: [
      { event: "response", errorCode: "timeout" },
      { event: "warning", code: "slow_answer" },
    ],
  })
})
