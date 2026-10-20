import { afterEach, expect, it, vi } from "vitest"
import type { ContextSource } from "../context/evidence.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { createContextEvidenceReader } from "../services/context-evidence.js"
import { gatherProjectEvidence } from "../services/project-gathering.js"
import { contextEvidenceFixture } from "../testing/context-evidence.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const handle of handles.splice(0)) await handle.close()
})

const fixture = async (provider = "example-calendar") => {
  const f = await contextEvidenceFixture(provider)
  handles.push(f)
  for (const accountId of [f.accountId, f.otherId]) {
    const input = sampleMeeting()
    input.meeting.accountId = accountId
    input.meeting.externalId = `launch-${accountId}`
    input.meeting.startedAt = 200
    input.meeting.title = "Harbour planning"
    input.transcripts[0].rows[0].text = "Harbour launch plan"
    input.transcripts[0].rows.push({ ...input.transcripts[0].rows[0], position: 1, text: "Harbour launch review" })
    await f.store.meetings.saveMeeting(input)
    await f.store.meetings.indexSearch({ accountId, limit: 1000 })
  }
  const source: ContextSource = { ...f.sources.message, kind: "meeting" }
  const reader = createContextEvidenceReader(f.port, [source])
  const request = { ...f.request, source, after: 100, before: 300 }
  return { ...f, source, reader, request }
}

it.each(["example-calendar", "sample-calendar"])(
  "gathers current transcript cues for %s with exact scope and stable pagination",
  async (provider) => {
    const f = await fixture(provider)
    const first = await f.reader.read(f.request)
    expect(first).toMatchObject({
      source: f.source,
      items: [{ text: "Harbour launch review", at: 200, timeKind: "meeting-start", revision: null }],
      coverage: { available: true, index: "ready", hasMore: true, completeness: "unknown" },
    })
    expect(first.items[0]?.ref).toMatch(new RegExp(`^meeting:${f.accountId}/\\d+/\\d+/1$`))
    const next = await f.reader.read({ ...f.request, cursor: first.next ?? undefined })
    expect(next).toMatchObject({ items: [{ text: "Harbour launch plan" }], next: null })
    expect(next.items[0]?.ref).toMatch(/\/0$/)
    expect((await f.reader.read({ ...f.request, after: 200, before: 201 })).items).toHaveLength(1)
    expect((await f.reader.read({ ...f.request, after: 100, before: 200 })).items).toEqual([])
    expect((await f.reader.read({ ...f.request, query: "harbour OR launch" })).items).toEqual([])
    const gathered = await gatherProjectEvidence(
      { evidence: f.port },
      { project: { name: "Harbour" }, sources: [f.source], scope: "explicit", after: 100, before: 300 },
    )
    expect(gathered.items).toHaveLength(2)
    expect(gathered.items.every((item) => item.kind === "meeting" && item.timeKind === "meeting-start")).toBe(true)
  },
)

it("measures UTF-8 cue and title bytes before hydration, moves past a cue too large to read and performs no writes", async () => {
  const f = await fixture()
  f.db.prepare("UPDATE meetings SET title=? WHERE account_id=?").run("Ж".repeat(100), f.accountId)
  f.db
    .prepare(
      "UPDATE meeting_transcript_rows SET text=text||? WHERE meeting_transcript_id IN (SELECT t.id FROM meeting_transcripts t JOIN meetings m ON m.id=t.meeting_id WHERE m.account_id=?)",
    )
    .run(" Ж".repeat(100), f.accountId)
  await f.store.meetings.indexSearch({ accountId: f.accountId, limit: 1000 })
  const first = await f.reader.read({ ...f.request, limit: 1 })
  const spy = vi.spyOn(f.db, "prepare")
  expect(await f.reader.read({ ...f.request, limit: 1, maxReadBytes: first.readBytes - 1 })).toMatchObject({
    items: [],
    readBytes: 0,
    oversized: { ref: first.items[0]?.ref, bytes: first.readBytes },
  })
  expect(spy.mock.calls.some(([sql]) => sql.startsWith("SELECT r.id,m.title"))).toBe(false)
  spy.mockRestore()
  f.db.exec("PRAGMA query_only=ON")
  const before = f.db.prepare("SELECT total_changes() AS n").get()
  expect(await f.reader.read({ ...f.request, limit: 1, maxReadBytes: first.readBytes })).toMatchObject({
    readBytes: first.readBytes,
  })
  expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(before)
})

it("omits pending, superseded, deleted and undated transcript rows without claiming full history", async () => {
  const f = await fixture()
  const rows =
    "SELECT r.id FROM meeting_transcript_rows r JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id JOIN meetings m ON m.id=t.meeting_id WHERE m.account_id=? AND m.external_id LIKE 'launch-%'"
  f.db
    .prepare(`INSERT INTO meeting_index_pending(indexable_type,id) SELECT 'meeting_transcript_row',id FROM (${rows})`)
    .run(f.accountId)
  expect(await f.reader.read(f.request)).toMatchObject({ items: [], coverage: { index: "pending" } })
  await f.store.meetings.indexSearch({ accountId: f.accountId, limit: 1000 })
  f.db.prepare("UPDATE meetings SET started_at=NULL WHERE account_id=?").run(f.accountId)
  expect(await f.reader.read(f.request)).toMatchObject({ items: [], coverage: { hasUndated: true } })
  f.db.prepare("UPDATE meetings SET started_at=200 WHERE account_id=?").run(f.accountId)
  f.db
    .prepare(
      "UPDATE meeting_transcripts SET superseded_at=1 WHERE meeting_id IN (SELECT id FROM meetings WHERE account_id=?)",
    )
    .run(f.accountId)
  expect((await f.reader.read(f.request)).items).toEqual([])
  f.db
    .prepare(
      "UPDATE meeting_transcripts SET superseded_at=NULL,deleted_at=1 WHERE meeting_id IN (SELECT id FROM meetings WHERE account_id=?)",
    )
    .run(f.accountId)
  expect((await f.reader.read(f.request)).items).toEqual([])
  f.db.prepare("UPDATE meeting_transcripts SET deleted_at=NULL").run()
  f.db.prepare("UPDATE meetings SET deleted_at=1 WHERE account_id=?").run(f.accountId)
  expect((await f.reader.read(f.request)).items).toEqual([])
  f.db.exec("DROP TABLE meeting_words")
  expect(await f.reader.read(f.request)).toMatchObject({
    items: [],
    coverage: { index: "missing", completeness: "unknown" },
  })
})

it("rejects changed account identities and foreign or malformed cue answers", async () => {
  const f = await fixture()
  const page = await f.reader.read(f.request)
  for (const patch of [
    { ref: `meeting:${f.otherId}/1/1/0` },
    { ref: `meeting:${f.accountId}/1` },
    { ref: (page.items[0]?.ref ?? "").replace(/\/1$/, "/01") },
    { timeKind: "sent" as const },
  ]) {
    const reader = createContextEvidenceReader(
      { read: async () => ({ ...page, items: page.items.map((item) => ({ ...item, ...patch })) }) },
      [f.source],
    )
    await expect(reader.read(f.request)).rejects.toMatchObject({ code: "invalid_response" })
  }
  f.db.prepare("UPDATE accounts SET external_id='ChangedExample' WHERE id=?").run(f.accountId)
  expect(await f.reader.read(f.request)).toMatchObject({ items: [], coverage: { available: false } })
})

it("rejects changed cursors before I/O and releases its snapshot after cancellation", async () => {
  const f = await fixture()
  const first = await f.reader.read(f.request)
  const prepare = f.db.prepare.bind(f.db)
  const spy = vi.spyOn(f.db, "prepare")
  await expect(
    f.reader.read({ ...f.request, query: "changed", cursor: first.next ?? undefined }),
  ).rejects.toMatchObject({ code: "validation_error" })
  expect(spy).not.toHaveBeenCalled()
  const controller = new AbortController()
  spy.mockImplementation((sql) => {
    const statement = prepare(sql)
    if (!sql.startsWith("SELECT id,at,ref")) return statement
    return {
      ...statement,
      all: (...args) => {
        const row = statement.all(...args)
        controller.abort()
        return row
      },
    }
  })
  await expect(f.reader.read({ ...f.request, signal: controller.signal })).rejects.toThrow()
  spy.mockRestore()
  expect((await f.reader.read(f.request)).items).toHaveLength(1)
})
