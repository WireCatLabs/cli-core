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
      const item = startRun({ runsDir: dir, profile: "synthetic", command: "chats list", cliVersion: app.version })
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
