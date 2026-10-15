import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { findRun, listRuns, readEvents, startRun } from "../../runs/run.js"
import { searchRuns } from "./search.js"

it("searches error codes, partial IDs and safe events with profile isolation and pagination", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-search-"))
  const run = startRun({
    runsDir: dir,
    profile: "work",
    command: "messages download",
    service: "tg",
    cliVersion: "1.0.0",
  })
  run.logger.info({
    event: "response",
    operation: "messages.download",
    errorCode: "rate_limited",
    ids: { message: "50" },
    message: "private synthetic payload",
    token: "synthetic forbidden token",
  })
  await run.finish("partial", {
    partial: { failed: 1, failures: [{ id: "50", stage: "download", errorCode: "rate_limited" }] },
  })
  appendFileSync(join(run.dir, "events.jsonl"), "{invalid JSON\n")
  const other = startRun({
    runsDir: dir,
    profile: "other",
    command: "messages download",
    service: "tg",
    cliVersion: "1.0.0",
  })
  await other.finish("failed", { errorCode: "rate_limited" })
  const result = searchRuns(dir, { profile: "work", errorCode: "rate_limited", status: "partial" })
  expect(result.items).toHaveLength(1)
  expect(result.items[0]).toMatchObject({
    partial: { failures: [{ id: "50" }] },
    events: [{ operation: "messages.download", error_code: "rate_limited" }],
  })
  expect(JSON.stringify(result)).not.toContain("private synthetic payload")
  expect(JSON.stringify(result)).not.toContain("synthetic forbidden token")
  expect(searchRuns(dir, { query: "50", profile: "work" }).items).toHaveLength(1)
  expect(searchRuns(dir, { errorCode: "rate_limited", limit: 1 }).hasMore).toBe(true)
  expect(searchRuns(dir, { errorCode: "rate_limited", limit: 1, page: 2 }).items).toHaveLength(1)
  expect(() => searchRuns(dir, { since: "not a date" })).toThrow("--since")
})

it("finds a code a finished run's events carried without opening the runs that carried none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-search-"))
  const hit = startRun({ runsDir: dir, profile: "work", command: "messages send", service: "tg", cliVersion: "1.0.0" })
  hit.logger.info({ event: "response", operation: "messages.send", outcome: "error", errorCode: "timeout" })
  await hit.finish("success")
  const miss = startRun({ runsDir: dir, profile: "work", command: "chats list", service: "tg", cliVersion: "1.0.0" })
  miss.logger.info({ event: "response", operation: "chats.list" })
  await miss.finish("success")
  writeFileSync(
    join(miss.dir, "events.jsonl"),
    '{"event":"response","operation":"messages.send","errorCode":"timeout"}\n',
  )
  const killed = startRun({
    runsDir: dir,
    profile: "work",
    command: "messages send",
    service: "tg",
    cliVersion: "1.0.0",
  })
  killed.logger.info({ event: "response", operation: "messages.send", errorCode: "timeout" })

  const ids = (search: Parameters<typeof searchRuns>[1]) => searchRuns(dir, search).items.map((item) => item.runId)
  expect(ids({ errorCode: "timeout" }).sort()).toEqual([hit.id, killed.id].sort())
  expect(ids({ operation: "messages.send" }).sort()).toEqual([hit.id, killed.id].sort())
})

it("reads runs written before their keys were snake_case, from the index and from run.json alike", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-search-old-"))
  const old = (runId: string) => ({
    runId,
    command: "messages download",
    profile: "work",
    startedAt: "2026-10-01T08:00:00.000Z",
    completedAt: "2026-10-01T08:00:01.000Z",
    status: "partial",
    durationMs: 1000,
    cliVersion: "0.1.0",
    errorCode: "rate_limited",
    partial: { failed: 1, stopReason: "limit", failures: [{ id: "5", stage: "download", errorCode: "rate_limited" }] },
    operations: ["messages.download"],
    codes: ["rate_limited"],
  })
  const day = join(dir, "2026-10-01")
  for (const id of ["20261001T080000Z-messages-download-aaaaaa", "20261001T080000Z-messages-download-bbbbbb"]) {
    mkdirSync(join(day, id), { recursive: true })
    writeFileSync(join(day, id, "run.json"), JSON.stringify(old(id)))
    writeFileSync(
      join(day, id, "events.jsonl"),
      `${JSON.stringify({
        time: "2026-10-01T08:00:00.500Z",
        severity: "error",
        body: "response",
        run_id: id,
        command: "messages download",
        attributes: { event: "response", operation: "messages.download", errorCode: "rate_limited", durationMs: 7 },
        resource: { service: "tg", version: "0.1.0" },
      })}\n`,
    )
  }
  appendFileSync(join(day, "index.jsonl"), `${JSON.stringify(old("20261001T080000Z-messages-download-aaaaaa"))}\n`)

  const runs = listRuns(dir)
  expect(runs.map((run) => run.runId).sort()).toEqual([
    "20261001T080000Z-messages-download-aaaaaa",
    "20261001T080000Z-messages-download-bbbbbb",
  ])
  expect(runs[0]).toMatchObject({ errorCode: "rate_limited", partial: { stopReason: "limit" } })
  const found = searchRuns(dir, { errorCode: "rate_limited", operation: "messages.download" })
  expect(found.items).toHaveLength(2)
  expect(found.items[0]?.events).toEqual([
    {
      time: "2026-10-01T08:00:00.500Z",
      event: "response",
      operation: "messages.download",
      error_code: "rate_limited",
      duration_ms: 7,
    },
  ])
  const shown = findRun(dir, "20261001T080000Z-messages-download-bbbbbb")
  expect(shown && readEvents(shown.dir)).toMatchObject([{ error_code: "rate_limited", duration_ms: 7 }])
})
