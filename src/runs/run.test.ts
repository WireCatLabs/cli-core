import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { logRecordSchema } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { findRun, listRuns, pruneRuns, readEvents, refuseRealStateInTests, runsDirFor, startRun } from "./run.js"

const runsDir = () => join(mkdtempSync(join(tmpdir(), "runs-")), "runs")

const started: ReturnType<typeof startRun>[] = []
afterEach(async () => {
  await Promise.all(started.splice(0).map((run) => run.finish("success")))
})

const begin = (dir: string, command = "chats list", now?: () => Date) => {
  const run = startRun({
    runsDir: dir,
    command,
    profile: "default",
    service: "tg",
    cliVersion: "0.0.0",
    ...(now ? { now } : {}),
  })
  started.push(run)
  return run
}

describe("a run directory", () => {
  it("exists before the command does anything, and says it is running", async () => {
    const dir = runsDir()
    const run = begin(dir)

    const metadata = JSON.parse(readFileSync(join(run.dir, "run.json"), "utf8")) as Record<string, unknown>
    expect(metadata).toMatchObject({ command: "chats list", profile: "default", status: "running" })
    expect(metadata.completed_at).toBeUndefined()
  })

  it("is named so that it sorts, and reads without being opened", async () => {
    const run = begin(runsDir(), "messages send", () => new Date("2026-09-20T08:44:31.123Z"))

    expect(run.id).toMatch(/^20260920T084431Z-messages-send-[0-9a-f]{6}$/)
    expect(run.dir).toContain(join("2026-09-20", run.id))
  })

  // Windows has no owner-only mode bits.
  it.skipIf(process.platform === "win32")(
    "**is readable by nobody else** — the directory as much as the file",
    async () => {
      const run = begin(runsDir())

      expect(statSync(run.dir).mode & 0o777).toBe(0o700)
      expect(statSync(join(run.dir, "run.json")).mode & 0o777).toBe(0o600)
      expect(statSync(join(run.dir, "events.jsonl")).mode & 0o777).toBe(0o600)
    },
  )

  it("writes one log record per event, and no colour ever", async () => {
    const run = begin(runsDir())
    run.logger.info({ event: "request", operation: "messages.list" })
    run.logger.info({ event: "response", operation: "messages.list", durationMs: 12 })
    await run.finish("success", { requests: 1 })

    const lines = readFileSync(join(run.dir, "events.jsonl"), "utf8").trimEnd().split("\n")
    for (const line of lines) v.parse(logRecordSchema, JSON.parse(line))
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      body: "request",
      run_id: run.id,
      command: "chats list",
      resource: { service: "tg", version: "0.0.0" },
      attributes: { event: "request", operation: "messages.list" },
    })
    expect(readEvents(run.dir)).toMatchObject([
      { event: "request", operation: "messages.list", severity: "info" },
      { event: "response", duration_ms: 12 },
    ])
    // biome-ignore lint/suspicious/noControlCharactersInRegex: an escape sequence is what must not be there.
    expect(readFileSync(join(run.dir, "events.jsonl"), "utf8")).not.toMatch(/\u001b\[/)
  })

  it("records how it ended, how long it took and how many operations it made", async () => {
    const run = begin(runsDir())
    await run.finish("failed", { requests: 2, errorCode: "authentication_error" })

    const metadata = JSON.parse(readFileSync(join(run.dir, "run.json"), "utf8")) as Record<string, unknown>
    expect(metadata).toMatchObject({ status: "failed", requests: 2, error_code: "authentication_error" })
    expect(metadata.completed_at).toBeTypeOf("string")
    expect(metadata.duration_ms).toBeTypeOf("number")
  })

  it("finishes once, whoever calls it twice", async () => {
    const run = begin(runsDir())
    await run.finish("success", { requests: 1 })
    await run.finish("failed", { requests: 99 })

    expect(JSON.parse(readFileSync(join(run.dir, "run.json"), "utf8"))).toMatchObject({ status: "success" })
  })
})

describe("reading runs back", () => {
  it("lists them newest first and finds one by id", async () => {
    const dir = runsDir()
    const older = begin(dir, "chats list", () => new Date("2026-09-18T10:00:00.000Z"))
    await older.finish("success", { requests: 2 })
    const newer = begin(dir, "messages send", () => new Date("2026-09-20T10:00:00.000Z"))
    await newer.finish("failed", { requests: 1 })

    expect(listRuns(dir).map((run) => run.command)).toEqual(["messages send", "chats list"])
    expect(findRun(dir, older.id)?.metadata.command).toBe("chats list")
    expect(findRun(dir, "no-such-run")).toBeUndefined()
  })

  it("reads the day's index rather than every run, the latest line of each run winning", async () => {
    const dir = runsDir()
    const finished = begin(dir, "chats list", () => new Date("2026-09-20T10:00:00.000Z"))
    finished.logger.info({ event: "response", operation: "chats.list", errorCode: "timeout" })
    finished.logger.warn({ event: "warning", code: "slow_answer" })
    await finished.finish("failed")
    const running = begin(dir, "messages send", () => new Date("2026-09-20T11:00:00.000Z"))

    const index = readFileSync(join(dir, "2026-09-20", "index.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
    expect(index).toHaveLength(3)
    expect(listRuns(dir).map(({ runId, status }) => ({ runId, status }))).toEqual([
      { runId: running.id, status: "running" },
      { runId: finished.id, status: "failed" },
    ])
    expect(listRuns(dir)[1]).toMatchObject({ operations: ["chats.list"], codes: ["slow_answer", "timeout"] })
    expect(statSync(join(dir, "2026-09-20", "index.jsonl")).mode & 0o777).toBe(0o600)
  })

  it("reads a day without an index run by run", async () => {
    const dir = runsDir()
    const run = begin(dir, "chats list", () => new Date("2026-09-20T10:00:00.000Z"))
    await run.finish("success")
    rmSync(join(dir, "2026-09-20", "index.jsonl"))

    expect(listRuns(dir).map((item) => item.runId)).toEqual([run.id])
  })

  it("reads a run the day's index does not name from its own run.json", async () => {
    const dir = runsDir()
    const indexed = begin(dir, "chats list", () => new Date("2026-09-20T10:00:00.000Z"))
    await indexed.finish("success")
    const index = join(dir, "2026-09-20", "index.jsonl")
    const kept = readFileSync(index, "utf8")
    const missing = begin(dir, "messages send", () => new Date("2026-09-20T11:00:00.000Z"))
    await missing.finish("failed")
    writeFileSync(index, kept)

    expect(listRuns(dir).map(({ runId, status }) => ({ runId, status }))).toEqual([
      { runId: missing.id, status: "failed" },
      { runId: indexed.id, status: "success" },
    ])
  })

  it("does not open a day before the one asked for", async () => {
    const dir = runsDir()
    const old = begin(dir, "chats list", () => new Date("2026-09-18T10:00:00.000Z"))
    await old.finish("success")
    const recent = begin(dir, "chats list", () => new Date("2026-09-20T10:00:00.000Z"))
    await recent.finish("success")
    writeFileSync(join(dir, "2026-09-18", "index.jsonl"), "not json at all\n")

    expect(listRuns(dir, { since: Date.parse("2026-09-19T00:00:00.000Z") }).map((run) => run.runId)).toEqual([
      recent.id,
    ])
  })

  it("answers with nothing at all when nothing was ever recorded", () => {
    expect(listRuns(join(tmpdir(), "runs-that-do-not-exist"))).toEqual([])
  })

  it("keeps the readable part of a log a killed process left half-written", async () => {
    const run = begin(runsDir())
    writeFileSync(join(run.dir, "events.jsonl"), '{"event":"request","seq":1}\n{"event":"resp')

    expect(readEvents(run.dir)).toEqual([{ event: "request", seq: 1 }])
  })
})

describe("what is kept, and for how long", () => {
  it("**removes a day past the horizon and keeps everything inside it**", () => {
    const dir = runsDir()
    for (const date of ["2026-08-01", "2026-09-19", "2026-09-20"]) mkdirSync(join(dir, date), { recursive: true })

    const removed = pruneRuns(dir, { keepDays: 30, now: new Date("2026-09-20T10:00:00.000Z") })

    expect(removed).toBe(1)
    expect(readdirSync(dir).sort()).toEqual(["2026-09-19", "2026-09-20"])
  })

  it("leaves alone anything that is not a day", () => {
    const dir = runsDir()
    mkdirSync(join(dir, "notes"), { recursive: true })
    mkdirSync(join(dir, "2020-01-01"), { recursive: true })

    pruneRuns(dir, { keepDays: 1, now: new Date("2026-09-20T10:00:00.000Z") })

    expect(readdirSync(dir)).toEqual(["notes"])
  })

  it("prunes as a recorded run starts, and not otherwise", async () => {
    const dir = runsDir()
    mkdirSync(join(dir, "2020-01-01"), { recursive: true })

    begin(dir)

    expect(readdirSync(dir)).not.toContain("2020-01-01")
  })
})

describe("the owner's real data folder", () => {
  it("is refused to a test, whatever HOME the fixture passed", () => {
    const real = { HOME: userInfo().homedir }
    const dir = join(runsDirFor({ appName: "chat-cli", envPrefix: "CHAT" } as never, real), "2026-10-27", "x")
    expect(() => refuseRealStateInTests(dir)).toThrow(/real data folder/)
    expect(() =>
      startRun({
        runsDir: runsDirFor({ appName: "chat-cli", envPrefix: "CHAT" } as never, real),
        command: "x",
        service: "chat",
        cliVersion: "0.0.0",
      }),
    ).toThrow(/real data folder/)
  })

  it("is left alone outside tests and for the sandbox's own folders", () => {
    const dir = join(userInfo().homedir, ".local", "share", "chat-cli", "runs", "x")
    expect(() => refuseRealStateInTests(dir, {})).not.toThrow()
    expect(() => refuseRealStateInTests(join(runsDir(), "x"))).not.toThrow()
  })
})
