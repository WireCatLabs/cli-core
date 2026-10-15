import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, runBatch } from "@wirecat/cli-base"
import { jsonlOf } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { afterEach, expect, it, vi } from "vitest"
import { failureContext } from "../errors/reasons.js"
import type { MeetingBatchReader } from "../meetings/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { createMeetingBatchReader } from "../services/meeting-batch.js"
import { searchMeetingHits } from "../services/meeting-hit-search.js"
import { openStore } from "../store/store.js"
import { addMeetingBatchCommand, formatMeetingBatch, prepareMeetingBatch } from "./meeting-batch.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const meta = () => ({ run_id: "synthetic-batch", duration_ms: 1, complete: true })
const input = (requests: { id: string; command: string[]; args: string[] }[]) => JSON.stringify({ requests })
const request = (id: string, command: "search" | "passage", ...args: string[]) => ({
  id,
  command: command === "search" ? ["search", "meetings"] : ["meetings", "passage"],
  args,
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "core-meeting-batch-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path }, now: () => 10000 })
  opened.push(store)
  const accountId = await store.saveAccount({ provider: "example", account: "AliceExample" }, { name: "Alice Example" })
  const foreign = await store.saveAccount({ provider: "example", account: "BobSample" }, { name: "Bob Sample" })
  const data = sampleMeeting()
  data.meeting.accountId = accountId
  const row = data.transcripts[0].rows[0]
  const rows = [0, 1, 2, 3].map((position) => ({
    ...row,
    position,
    text: `budget sample ${position}`,
    startMs: position * 1000,
    endMs: position * 1000 + 900,
  }))
  const [head, ...tail] = rows
  if (!head) throw Error("missing fixture cue")
  data.transcripts[0].rows = [head, ...tail]
  const saved = await store.meetings.saveMeeting(data)
  const transcript = saved.transcripts[0]?.transcript.id
  if (!transcript) throw Error("missing fixture transcript")
  const ref = (position: number) => `meeting:${accountId}/${saved.meeting.id}/${transcript}/${position}`
  return { store, accountId, foreign, ref, reader: createMeetingBatchReader(store, accountId) }
}

it("refreshes once and keeps duplicate queries and their own cursors in the selected account", async () => {
  const f = await fixture(),
    index = vi.spyOn(f.store.meetings, "indexSearch")
  const report = await runBatch(
    prepareMeetingBatch(
      input([
        request("q1", "search", "budget", "--limit", "1"),
        request("q2", "search", "sample", "--limit", "2"),
        request("q3", "search", "budget", "--limit", "1"),
      ]),
      f.reader,
      meta,
    ),
  )
  expect(index).toHaveBeenCalledTimes(1)
  expect(index).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: f.accountId, maxReadBytes: 4194304, limit: 1000 }),
  )
  expect(report.read_bytes_reserved).toBe(4 * 4194304)
  expect(report.items.map((item) => item.status)).toEqual(["ok", "ok", "ok"])
  const first = report.items[0],
    third = report.items[2]
  if (first?.status !== "ok" || third?.status !== "ok") throw Error("missing successful fixture result")
  expect(first.answer).toEqual(third.answer)
  const body = first.answer as { page: { next_cursor: string }; items: { ref: string }[] }
  expect(body.items[0]?.ref).toContain(`meeting:${f.accountId}/`)
  expect(body.page.next_cursor).toBeTruthy()
  await searchMeetingHits(f.store, "budget", { accountId: f.accountId, limit: 1 })
  expect(index).toHaveBeenCalledTimes(2)
})

it("retains overlapping passages while isolating stale fingerprints and foreign accounts", async () => {
  const f = await fixture(),
    index = vi.spyOn(f.store.meetings, "indexSearch")
  const report = await runBatch(
    prepareMeetingBatch(
      input([
        request("p1", "passage", f.ref(1), "--before-n", "1", "--after-n", "1"),
        request("stale", "passage", f.ref(1), "--expected-fingerprint", "f".repeat(64)),
        request("foreign", "passage", f.ref(1).replace(`meeting:${f.accountId}/`, `meeting:${f.foreign}/`)),
        request("p2", "passage", f.ref(2), "--before-n", "1", "--after-n", "1"),
      ]),
      f.reader,
      meta,
    ),
    { failureContext: failureContext() },
  )
  expect(report.items.map((item) => item.status)).toEqual(["ok", "error", "error", "ok"])
  expect(report.items[2]).toMatchObject({ error: { code: "not_found" } })
  expect(report.complete).toBe(false)
  expect(index).not.toHaveBeenCalled()
  const first = report.items[0],
    last = report.items[3]
  if (first?.status !== "ok" || last?.status !== "ok") throw Error("missing fixture passage")
  expect(first.answer).toMatchObject({ item: { items: [{ position: 0 }, { position: 1 }, { position: 2 }] } })
  expect(last.answer).toMatchObject({ item: { items: [{ position: 1 }, { position: 2 }, { position: 3 }] } })
})

it("renders source context safely alongside word hits", async () => {
  const f = await fixture()
  const report = await runBatch(prepareMeetingBatch(input([request("q", "search", "budget")]), f.reader, meta))
  const result = report.items[0]
  if (result?.status !== "ok") throw Error("missing search result")
  const answer = result.answer as { items: { source: { title: string; started_at: string; url: string } }[] }
  const hit = answer.items[0]
  if (!hit) throw Error("missing fixture hit")
  hit.source = {
    title: "[Example](https://example.test/action)",
    started_at: "2026-10-15T12:00:00.000Z",
    url: "https://example.test/source",
  }
  const text = formatMeetingBatch(report, "text")
  expect(text).toContain("2026-10-15T12:00:00.000Z")
  expect(text).toContain("https://example.test/source")
  expect(formatMeetingBatch(report, "markdown")).not.toContain("[Example](")
  expect(text.match(/Coverage:/g)).toHaveLength(1)
})

it("rejects unsupported or malformed arguments before any reader callback", () => {
  const callback = vi.fn(),
    reader: MeetingBatchReader = { index: callback, search: callback, passage: callback }
  for (const args of [
    ["budget", "--model", "remote"],
    ["budget", "--profile", "other"],
    ["budget", "--help"],
    ["budget", "extra"],
    ["budget", "--since-time", "2026-02-30"],
  ])
    expect(() => prepareMeetingBatch(input([request("q", "search", ...args)]), reader, meta)).toThrow(CliError)
  for (const args of [
    ["meeting:1/1"],
    ["invalid"],
    ["meeting:1/1/1/0", "--expected-fingerprint", "bad"],
    ["meeting:1/1/1/0", "--before-n", "1000"],
  ])
    expect(() => prepareMeetingBatch(input([request("p", "passage", ...args)]), reader, meta)).toThrow(CliError)
  expect(() =>
    prepareMeetingBatch(input([{ id: "write", command: ["meetings", "sync"], args: [] }]), reader, meta),
  ).toThrow("unsupported")
  expect(callback).not.toHaveBeenCalled()
})

it("keeps partial indexing visible, memoizes an index failure and still reads a passage", async () => {
  const f = await fixture(),
    search = vi.fn(f.reader.search)
  const failing = {
    ...f.reader,
    search,
    index: vi.fn(async () => {
      throw new CliError("configuration_error", "index unavailable")
    }),
  }
  const requests = [
    request("q1", "search", "budget"),
    request("q2", "search", "sample"),
    request("p", "passage", f.ref(1)),
  ]
  const failed = await runBatch(prepareMeetingBatch(input(requests), failing, meta))
  expect(failed.items.map((item) => item.status)).toEqual(["error", "error", "ok"])
  expect(failing.index).toHaveBeenCalledTimes(1)
  expect(search).not.toHaveBeenCalled()
  const pending = { ...f.reader, index: vi.fn(async () => ({ indexed: 0, remaining: 1 })) }
  const report = await runBatch(prepareMeetingBatch(input([request("q", "search", "budget")]), pending, meta))
  expect(report.items[0]).toMatchObject({
    status: "ok",
    complete: false,
    answer: { missing: expect.any(Array), meta: { complete: false } },
  })
})

it("prints one correlated JSONL item per input and a truthful final summary on read refusal", async () => {
  const output = vi.fn(),
    callback = vi.fn(),
    reader: MeetingBatchReader = { index: callback, search: callback, passage: callback }
  const program = new Command("example").option("--jsonl")
  addMeetingBatchCommand(program, {
    reader,
    input: async () => input([request("q", "search", "budget"), request("p", "passage", "meeting:1/1/1/0")]),
    meta,
    signal: () => undefined,
    fields: () => undefined,
    output,
  })
  await program.parseAsync(["batch", "-", "--max-read-bytes", "1", "--jsonl"], { from: "user" })
  const body = output.mock.calls[0]?.[0]
  const records = jsonlOf({ ...body, meta: { ...meta(), ...body.meta } })
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(records.map((record) => record.type)).toEqual(["item", "item", "end"])
  expect(records[0].data).toMatchObject({ id: "q", status: "not_run" })
  expect(records[2]).toMatchObject({ complete: false, issues: [{ source: "q" }, { source: "p" }] })
  expect(callback).not.toHaveBeenCalled()
})

it("uses compact passage formatting with one coverage statement for each result", async () => {
  const f = await fixture()
  const report = await runBatch(
    prepareMeetingBatch(
      input([request("p1", "passage", f.ref(1)), request("p2", "passage", f.ref(2))]),
      f.reader,
      meta,
    ),
  )
  const text = formatMeetingBatch(report, "text"),
    markdown = formatMeetingBatch(report, "markdown")
  expect(text).toContain(f.ref(1))
  expect(text).toContain("00:00:01")
  expect(text.match(/Cues:/g)).toHaveLength(2)
  expect(markdown).toContain(`\`${f.ref(1)}\``)
})
