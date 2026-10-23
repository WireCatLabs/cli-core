import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import * as v from "valibot"
import { expect, it } from "vitest"
import { ENTITIES } from "../../entities/index.js"
import { listRuns, runsDirFor, startRun } from "../../runs/run.js"
import { run } from "../program.js"
import { runsCommand } from "./command.js"
import { runsSearchCommand } from "./search-command.js"

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-search-"))
  const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", version: "1.0.0", description: "Synthetic" }
  const env = {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "unused.sqlite"),
  }
  const dir = runsDirFor(app, env)
  const call = async (argv: string[]) => {
    const streams = captureStreams()
    const code = await run(
      argv,
      {
        app,
        commands: () => [runsCommand(app), new Command("search").addCommand(runsSearchCommand(app))],
      },
      { streams, env, tty: false },
    )
    return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
  }
  return { app, env, dir, call }
}

it("searches before paging without a linked profile, a store or another recorded run", async () => {
  const { app, env, dir, call } = setup()
  for (const day of [1, 2, 3]) {
    const item = startRun({
      runsDir: dir,
      profile: "work",
      command: "messages download",
      service: "chat",
      cliVersion: app.version,
      now: () => new Date(`2026-10-0${day}T10:00:00Z`),
    })
    item.logger.info({
      event: "response",
      operation: "messages.download",
      errorCode: "timeout",
      message: "private synthetic payload",
      token: "synthetic forbidden token",
    })
    await item.finish(day === 3 ? "success" : "failed", day === 3 ? {} : { errorCode: "timeout" })
  }
  const before = listRuns(dir)
  const query = "timeout messages.download status:FAILED error_code:timeout operation:messages.download profile:work"
  const first = await call(["search", "runs", query, "--limit", "1", "--json"])
  expect(first.code, first.stderr).toBe(0)
  const body = JSON.parse(first.stdout)
  expect(body.items).toHaveLength(1)
  expect(v.parse(ENTITIES["run.hit"], body.items[0]).started_at).toBe("2026-10-02T10:00:00.000Z")
  expect(body.next[0]).toMatchObject({ command: "search runs", args: { query, page: 2, limit: 1 } })
  const second = await call(["search", "runs", query, "--limit", "1", "--page", "2", "--json=run_id,status"])
  expect(second.code, second.stderr).toBe(0)
  expect(JSON.parse(second.stdout).items[0]).toEqual({ run_id: before[2]?.runId, status: "failed" })
  expect(JSON.parse(second.stdout).page.has_more).toBe(false)
  expect(first.stdout).not.toContain("private synthetic payload")
  expect(first.stdout).not.toContain("synthetic forbidden token")
  expect(listRuns(dir)).toEqual(before)
  expect(existsSync(env.MESSAGING_STORE)).toBe(false)
  expect(existsSync(env.CHAT_CONFIG_DIR)).toBe(false)
})

it.each([
  ["search", "runs", "runtime:node", "--json"],
  ["search", "runs", "status:failed OR status:success", "--json"],
  ["search", "runs", "status:failed status:success", "--json"],
  ["search", "runs", "text:time*", "--json"],
  ["search", "runs", "--status", "failed", "--json"],
  ["runs", "search", "timeout", "--json"],
])("refuses unsupported or retired diagnostic search syntax: %j", async (...argv) => {
  const { env, call } = setup()
  const answer = await call(argv)
  expect(answer.code, answer.stderr).toBe(2)
  expect(answer.stdout).toBe("")
  expect(existsSync(env.MESSAGING_STORE)).toBe(false)
})
