import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type MeetingSeriesHistoryRequest, validateMeetingSeriesHistory } from "../meetings/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { openCache } from "./open.js"
import { meetingSeriesHistoryOver } from "./sqlite/meeting-series-history.js"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})
const request: MeetingSeriesHistoryRequest = { accountId: 1, externalId: "example-series", after: 0, before: 3000 }
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-series-history-")), "fixture.db")
  const store = await openStore({ path })
  handles.push(store)
  const accountId = await store.saveAccount({ provider: "example", account: "invented" }, { name: "Invented" })
  const otherId = await store.saveAccount({ provider: "sample", account: "invented" }, { name: "Invented" })
  const save = async (externalId: string, startedAt: number | null, overrides = {}) => {
    const input = sampleMeeting()
    return store.meetings.saveMeeting({
      ...input,
      meeting: { ...input.meeting, accountId, externalId, startedAt, ...overrides },
    })
  }
  const db = await openCache(path)
  handles.push(db)
  return { path, store, db, accountId, otherId, save, input: { ...request, accountId } }
}

describe("exact series history", () => {
  it("finds the exact account key, returns bounded metadata and stable newest-first ties", async () => {
    const { store, save, input, otherId } = await fixture()
    const oldest = await save("first", 0)
    const second = await save("second", 1000)
    const third = await save("third", 1000)
    await save("outside", 3000)
    await save("other-account", 2000, { accountId: otherId })
    const different = sampleMeeting().meeting.series
    await save("similar-title", 2000, { series: { ...different, externalId: "other-series" } })
    const found = await store.meetings.seriesHistory({ ...input, limit: 2 })
    expect(found.series).toEqual({
      id: oldest.series?.id,
      externalId: input.externalId,
      title: "Example planning",
      eventSeriesId: null,
      updatedAt: 3000,
    })
    expect(found.items.map((item) => item.id)).toEqual([third.meeting.id, second.meeting.id])
    expect(found.hasMore).toBe(true)
    expect(found.hasUndated).toBe(false)
    expect(Object.keys(found.items[0] ?? {}).sort()).toEqual(
      ["id", "externalId", "title", "eventId", "startedAt", "endedAt", "updatedAt"].sort(),
    )
    const all = await store.meetings.seriesHistory(input)
    expect(all.items.map((item) => item.id)).toEqual([third.meeting.id, second.meeting.id, oldest.meeting.id])
    expect(all.hasMore).toBe(false)
  })

  it("distinguishes missing series, empty windows, undated rows and soft deletion", async () => {
    const { store, db, save, input, otherId } = await fixture()
    expect(await store.meetings.seriesHistory(input)).toEqual({
      series: null,
      items: [],
      hasMore: false,
      hasUndated: false,
    })
    const stored = await save("undated", null)
    await save("deleted", 1000, { deletedAt: 2000 })
    let found = await store.meetings.seriesHistory(input)
    expect(found.series?.id).toBe(stored.series?.id)
    expect(found.items).toEqual([])
    expect(found.hasUndated).toBe(true)
    expect((await store.meetings.seriesHistory({ ...input, accountId: otherId })).series).toBeNull()
    expect((await store.meetings.seriesHistory({ ...input, externalId: "Example-series" })).series).toBeNull()
    db.prepare("UPDATE meetings SET deleted_at=2000 WHERE id=?").run(stored.meeting.id)
    expect((await store.meetings.seriesHistory(input)).hasUndated).toBe(false)
    db.prepare("UPDATE meeting_series SET deleted_at=2000 WHERE id=?").run(stored.series?.id ?? 0)
    found = await store.meetings.seriesHistory(input)
    expect(found.series).toBeNull()
  })

  it("does not hydrate omitted fields, transcripts or search queues", async () => {
    const { store, db, save, input } = await fixture()
    const saved = await save("first", 1000)
    db.prepare("UPDATE meetings SET metadata=?, description=? WHERE id=?").run(
      "x".repeat(20000),
      "x".repeat(20000),
      saved.meeting.id,
    )
    db.prepare("UPDATE meeting_series SET metadata=?, description=? WHERE id=?").run(
      "x".repeat(20000),
      "x".repeat(20000),
      saved.series?.id ?? 0,
    )
    const before = db.prepare("SELECT * FROM meeting_index_pending ORDER BY id").all()
    const spy = vi.spyOn(db, "prepare")
    const found = await meetingSeriesHistoryOver({ database: db }).seriesHistory({ ...input, maxReadBytes: 200 })
    expect(found.items).toHaveLength(1)
    expect(spy.mock.calls.some(([sql]) => /transcript|SELECT \*|\bUPDATE\b|\bINSERT\b/i.test(sql))).toBe(false)
    spy.mockRestore()
    expect(db.prepare("SELECT * FROM meeting_index_pending ORDER BY id").all()).toEqual(before)
    expect((await store.meetings.seriesHistory(input)).items).toEqual(found.items)
  })

  it.each(["series", "lookahead"])("refuses oversized UTF-8 %s text before loading values", async (target) => {
    const { db, save, input } = await fixture()
    const saved = await save("first", 1000)
    await save("second", 2000)
    if (target === "series")
      db.prepare("UPDATE meeting_series SET title=? WHERE id=?").run("界".repeat(100), saved.series?.id ?? 0)
    else db.prepare("UPDATE meetings SET title=? WHERE id=?").run("界".repeat(100), saved.meeting.id)
    const spy = vi.spyOn(db, "prepare")
    await expect(
      meetingSeriesHistoryOver({ database: db }).seriesHistory({ ...input, limit: 1, maxReadBytes: 200 }),
    ).rejects.toMatchObject({ code: "validation_error" })
    expect(spy.mock.calls.some(([sql]) => sql.startsWith("SELECT id, external_id"))).toBe(false)
  })

  it("keeps byte probes and metadata in a single snapshot under concurrent growth", async () => {
    const { db, path, save, input } = await fixture()
    const saved = await save("first", 1000)
    const writer = await openCache(path)
    handles.push(writer)
    const prepare = db.prepare.bind(db)
    let changed = false
    const database = {
      ...db,
      prepare(sql: string) {
        const statement = prepare(sql)
        if (!sql.includes("sum(read_bytes)")) return statement
        return {
          ...statement,
          get(...params: Parameters<typeof statement.get>) {
            const found = statement.get(...params)
            if (!changed) {
              changed = true
              writer.prepare("UPDATE meetings SET title=? WHERE id=?").run("界".repeat(100), saved.meeting.id)
            }
            return found
          },
        }
      },
    }
    const reader = meetingSeriesHistoryOver({ database })
    expect((await reader.seriesHistory({ ...input, maxReadBytes: 200 })).items[0]?.title).toBe("Example planning")
    expect(changed).toBe(true)
    await expect(reader.seriesHistory({ ...input, maxReadBytes: 200 })).rejects.toMatchObject({
      code: "validation_error",
    })
  })

  it("checks cancellation before SQL and after reads, then releases the snapshot", async () => {
    const { db, save, input } = await fixture()
    await save("first", 1000)
    const controller = new AbortController()
    const prepare = db.prepare.bind(db)
    const database = {
      ...db,
      prepare(sql: string) {
        const statement = prepare(sql)
        if (!sql.startsWith("SELECT 1 FROM meetings")) return statement
        return {
          ...statement,
          get(...params: Parameters<typeof statement.get>) {
            const found = statement.get(...params)
            controller.abort(new Error("Invented cancellation"))
            return found
          },
        }
      },
    }
    await expect(
      meetingSeriesHistoryOver({ database }).seriesHistory({ ...input, signal: controller.signal }),
    ).rejects.toThrow("Invented cancellation")
    const spy = vi.spyOn(db, "prepare")
    await expect(
      meetingSeriesHistoryOver({ database: db }).seriesHistory({ ...input, signal: controller.signal }),
    ).rejects.toThrow("Invented cancellation")
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    expect((await meetingSeriesHistoryOver({ database: db }).seriesHistory(input)).items).toHaveLength(1)
  })
})

describe("series history validation", () => {
  it.each([
    { accountId: 0 },
    { accountId: 1.5 },
    { externalId: "" },
    { externalId: "\nexample" },
    { externalId: "界".repeat(1400) },
    { externalId: null },
    { after: NaN },
    { before: Infinity },
    { after: 0.5 },
    { before: 8640000000000001 },
    { after: 3000 },
    { after: 4000 },
    { limit: null },
    { maxReadBytes: null },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { maxReadBytes: 0 },
    { maxReadBytes: 4194305 },
  ])("rejects invalid inputs before database preparation: %j", async (patch) => {
    const { db } = await fixture()
    const spy = vi.spyOn(db, "prepare")
    await expect(
      meetingSeriesHistoryOver({ database: db }).seriesHistory({ ...request, ...patch } as MeetingSeriesHistoryRequest),
    ).rejects.toMatchObject({ code: "validation_error" })
    expect(spy).not.toHaveBeenCalled()
  })
  it("preserves opaque identifiers and absolute date boundaries without trimming or guessing", () => {
    expect(
      validateMeetingSeriesHistory({
        ...request,
        externalId: " opaque/key:A ",
        after: -8640000000000000,
        before: 8640000000000000,
      }),
    ).toMatchObject({ externalId: " opaque/key:A ", limit: 20, maxReadBytes: 262144 })
  })
})
