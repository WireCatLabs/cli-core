import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { aggregateMeetingStats, NO_SERIES } from "../meetings/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { openCache } from "../store/open.js"
import { meetingSelectionSql } from "../store/sqlite/meeting-selection.js"
import { meetingCountsSql } from "../store/sqlite/meeting-stats.js"
import { type MessageStore, openStore } from "../store/store.js"
import { readMeetingCounts, readMeetingStats } from "./meeting-stats.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const DAY = 86_400_000
const MONDAY = Date.UTC(2026, 9, 19, 10)

const fixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "zm-test-stats-")), "store.db") })
  stores.push(store)
  const accountId = await store.accounts.saveAccount({ provider: "example", account: "alice-example" }, { name: "A" })
  for (const [name, startedAt] of [
    ["first", MONDAY],
    ["second", MONDAY + 8 * DAY],
  ] as const) {
    const input = sampleMeeting()
    input.meeting.accountId = accountId
    input.meeting.externalId = `example-${name}`
    input.meeting.startedAt = startedAt
    delete input.meeting.series
    input.transcripts[0].contentHash = `invented-${name}`
    input.transcripts[0].rows = [
      { ...input.transcripts[0].rows[0], position: 0, startMs: 0, endMs: 4000, text: "We ship the example plan" },
      {
        ...input.transcripts[0].rows[0],
        position: 1,
        startMs: 4000,
        endMs: 5000,
        speakerParticipantPosition: null,
        speakerName: "Bob Sample",
        text: "Fine",
      },
    ] as (typeof input.transcripts)[0]["rows"]
    await store.meetings.saveMeeting(input)
  }
  return { store, accountId }
}

it("counts talk time, lines and words per speaker and meetings per week", async () => {
  const { store, accountId } = await fixture()
  const stats = await readMeetingStats(store, { accountId, timeZone: "Europe/Madrid" })
  expect(stats).toMatchObject({ timeZone: "Europe/Madrid", meetings: 2, lines: 4, words: 12, talkMs: 10000 })
  expect(
    stats.speakers.map(({ name, meetings, lines, talkMs, share }) => ({ name, meetings, lines, talkMs, share })),
  ).toEqual([
    { name: "Alice Example", meetings: 2, lines: 2, talkMs: 8000, share: 0.8 },
    { name: "Bob Sample", meetings: 2, lines: 2, talkMs: 2000, share: 0.2 },
  ])
  expect(stats.speakers[0]?.key).toMatch(/^person:\d+$/)
  expect(stats.speakers[1]?.key).toBe("name:bob sample")
  expect(stats.weeks).toEqual([
    { weekStart: "2026-10-19", meetings: 1, talkMs: 5000 },
    { weekStart: "2026-10-26", meetings: 1, talkMs: 5000 },
  ])
})

it("reads only the meetings the filters select", async () => {
  const { store, accountId } = await fixture()
  const stats = await readMeetingStats(store, { accountId, since: MONDAY + DAY })
  expect(stats).toMatchObject({ meetings: 1, talkMs: 5000 })
})

it("counts a meeting's earliest current transcript only, so a second one does not double the talk", async () => {
  const { store, accountId } = await fixture()
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  input.meeting.externalId = "example-twice"
  input.meeting.startedAt = MONDAY + 20 * DAY
  delete input.meeting.series
  const local = { ...input.transcripts[0], source: "local", contentHash: "invented-local" }
  input.transcripts = [input.transcripts[0], local] as unknown as typeof input.transcripts
  const saved = await store.meetings.saveMeeting(input)
  expect(saved.transcripts.length).toBe(2)
  expect((await readMeetingStats(store, { accountId, meetingId: saved.meeting.id })).talkMs).toBe(1000)
})

it("starts weeks on Monday in the chosen zone and refuses an unknown zone", () => {
  const row = {
    meetingId: 1,
    startMs: 0,
    endMs: 1000,
    words: 1,
    personId: null,
    personName: null,
    identityId: null,
    identityName: null,
    speakerName: null,
  }
  // Sunday 23:30 UTC is already Monday in Madrid.
  const sunday = Date.UTC(2026, 9, 25, 23, 30)
  expect(aggregateMeetingStats([{ ...row, startedAt: sunday }]).weeks[0]?.weekStart).toBe("2026-10-19")
  expect(aggregateMeetingStats([{ ...row, startedAt: sunday }], "Europe/Madrid").weeks[0]?.weekStart).toBe("2026-10-26")
  expect(aggregateMeetingStats([{ ...row, startedAt: null }]).speakers[0]?.key).toBe("unknown")
  expect(() => aggregateMeetingStats([], "Mars/Base")).toThrow(/IANA/)
})

const countsFixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "zm-test-counts-")), "store.db") })
  stores.push(store)
  const accountId = await store.accounts.saveAccount({ provider: "example", account: "alice-example" }, { name: "A" })
  const MINUTE = 60_000
  const meetings = [
    { name: "sync-1", startedAt: MONDAY, durationMs: 30 * MINUTE, endedAt: null, series: true, transcript: true },
    { name: "sync-2", startedAt: MONDAY + 8 * DAY, durationMs: null, endedAt: 60 * MINUTE, series: true },
    { name: "ad-hoc", startedAt: MONDAY + DAY, durationMs: null, endedAt: null, series: false },
  ]
  for (const meeting of meetings) {
    const input = sampleMeeting()
    input.meeting.accountId = accountId
    input.meeting.externalId = `example-${meeting.name}`
    input.meeting.startedAt = meeting.startedAt
    input.meeting.durationMs = meeting.durationMs
    input.meeting.endedAt = meeting.endedAt === null ? null : meeting.startedAt + meeting.endedAt
    if (meeting.series && input.meeting.series) input.meeting.series.title = "Weekly sync"
    else delete input.meeting.series
    if (meeting.transcript) input.transcripts[0].contentHash = `invented-${meeting.name}`
    else input.transcripts = [] as unknown as typeof input.transcripts
    await store.meetings.saveMeeting(input)
  }
  return { store, accountId }
}

it("counts meetings, minutes and transcripts per day, week and series; no end means no minutes", async () => {
  const { store, accountId } = await countsFixture()
  const counted = async (by: "day" | "week" | "series", limit?: number) => {
    const { selection: _, ...counts } = await readMeetingCounts(store, {
      accountId,
      by,
      timeZone: "UTC",
      ...(limit ? { limit } : {}),
    })
    return counts
  }
  const row = (
    key: string,
    name: string | null,
    meetings: number,
    minutes: number,
    mean: number | null,
    t: number,
  ) => ({
    key,
    name,
    meetings,
    minutes,
    meanMinutes: mean,
    transcripts: t,
  })
  expect(await counted("week")).toEqual({
    by: "week",
    timeZone: "UTC",
    meetings: 3,
    minutes: 90,
    meanMinutes: 45,
    transcripts: 1,
    rows: [row("2026-10-19", null, 2, 30, 30, 1), row("2026-10-26", null, 1, 60, 60, 0)],
    hasMore: false,
  })
  expect((await counted("day", 1)).rows).toEqual([row("2026-10-27", null, 1, 60, 60, 0)])
  expect((await counted("day", 1)).hasMore).toBe(true)
  expect((await counted("series")).rows).toEqual([
    row("series:example-series", "Weekly sync", 2, 90, 45, 1),
    row(NO_SERIES, null, 1, 0, null, 0),
  ])
})

it("reads meetings through meetings_by_time, never a scan or a sort", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "zm-test-plan-")), "store.db")
  await (await openStore({ path })).close()
  const database = await openCache(path)
  try {
    for (const selection of [{ accountId: 1 }, { accountId: 1, since: MONDAY, until: MONDAY + DAY }]) {
      const { clauses, params } = meetingSelectionSql(selection)
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${meetingCountsSql(clauses.join(" AND "))}`)
        .all(...params)
        .map((row) => String(row.detail))
      expect(plan.join("\n")).toContain("meetings_by_time")
      expect(plan.filter((detail) => detail.startsWith("SCAN") || detail.includes("TEMP B-TREE"))).toEqual([])
    }
  } finally {
    database.close()
  }
})
