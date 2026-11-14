import { expect, it } from "vitest"
import { linkEvent } from "./events.js"
import { callMeetingTool } from "./mcp/index.js"
import type { SourceMeeting } from "./model.js"
import { pull } from "./pull.js"
import { meetingsList, meetingsSearch } from "./reads.js"
import { fakeMeetingSource, memoryMeetingStore, sampleEvent, sampleMeeting } from "./testing/index.js"

it("does not expose arbitrary store exception text through MCP", async () => {
  const store = memoryMeetingStore()
  store.meetings = async () => {
    throw new Error("Invented confidential meeting text")
  }
  const result = await callMeetingTool(store, "meetings_list", {}, { limit: 100 })
  expect(result.structuredContent).toEqual({
    error: {
      code: "internal_error",
      reason: "command.crashed",
      message: "the command failed; this is a bug",
      retry: { safe: false },
    },
  })
  expect(JSON.stringify(result)).not.toContain("confidential")
})

it("rejects invalid read filters and unsafe page arithmetic before calling a store", async () => {
  const store = memoryMeetingStore()
  store.meetings = async () => {
    throw new Error("Store must not be called")
  }
  store.search = store.meetings as never
  for (const filter of [
    { since: Number.NaN },
    { until: Infinity },
    { since: 2, until: 1 },
    { accountId: 0 },
    { offset: -1 },
  ]) {
    await expect(meetingsList(store, filter)).rejects.toMatchObject({ code: "validation_error" })
    await expect(meetingsSearch(store, "example", filter)).rejects.toMatchObject({ code: "validation_error" })
  }
  await expect(meetingsList(store, { limit: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({
    code: "validation_error",
  })
  await expect(meetingsList(store, { limit: 3, offset: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({
    code: "validation_error",
  })
})

it("returns the stored owner link when automatic linking loses a race", async () => {
  const store = memoryMeetingStore()
  const details = await store.saveMeeting(sampleMeeting())
  const owner = await store.createEvent({ ...sampleEvent(), origin: "owner" }, 1)
  const link = store.linkMeeting.bind(store)
  store.linkMeeting = async (id, eventId, now) => {
    await link(id, owner.id, now, "owner")
    await link(id, eventId, now)
  }
  expect((await linkEvent(store, details, 2))?.id).toBe(owner.id)
  const count = (await store.events()).length
  expect((await linkEvent(store, details, 3))?.id).toBe(owner.id)
  expect((await store.events()).length).toBe(count)
})

it("explicit lookback revisits recently discovered meetings for late transcripts", async () => {
  const store = memoryMeetingStore()
  let available = false
  const source = fakeMeetingSource({
    async meetings(since) {
      return Date.parse(since) <= 1000 ? await fakeMeetingSource().meetings(since) : []
    },
    async transcript() {
      return available ? [{ startMs: 0, endMs: 1, speaker: null, text: "Late example" }] : null
    },
  })
  await pull(source, store, { accountId: 1, since: "1970-01-01T00:00:00Z", now: 2000 })
  available = true
  expect((await pull(source, store, { accountId: 1, now: 3000 })).meetings).toBe(0)
  expect((await pull(source, store, { accountId: 1, now: 4000, lookbackMs: 3000 })).transcriptRows).toBe(1)
  const meeting = (await store.meetings())[0]
  expect((await store.meeting(meeting?.id ?? 0))?.transcripts[0]?.rows[0]?.text).toBe("Late example")
  for (const lookbackMs of [-1, 0.5, Infinity, 31 * 86400000 + 1])
    await expect(pull(source, store, { accountId: 1, now: 5000, lookbackMs })).rejects.toThrow(/lookback/)
})

it("a pull stopped by its budget keeps what it saved, oldest first, and the next goes on from the first not reached", async () => {
  const store = memoryMeetingStore()
  const occurrence = (id: string, second: number): SourceMeeting => ({
    series: null,
    occurrence: {
      id,
      seriesId: id,
      title: `Example ${id}`,
      startedAt: new Date(second * 1000).toISOString(),
      endedAt: new Date(second * 1000 + 500).toISOString(),
    },
  })
  const asked: string[] = []
  const source = fakeMeetingSource({
    async meetings(since) {
      asked.push(since)
      return [occurrence("c", 30), occurrence("a", 10), occurrence("b", 20)].filter(
        ({ occurrence: { startedAt } }) => startedAt >= since,
      )
    },
  })
  let left = 2
  const budget = { take: () => (left-- > 0 ? null : ("deadline" as const)) }
  const first = await pull(source, store, { accountId: 1, since: "1970-01-01T00:00:00.000Z", now: 40_000, budget })
  expect(first).toMatchObject({ meetings: 2, stopped: "deadline", remaining: 1 })
  expect((await store.meetings()).map(({ title }) => title).sort()).toEqual(["Example a", "Example b"])
  expect(await store.cursor(1)).toBe("1970-01-01T00:00:30.000Z")

  const second = await pull(source, store, { accountId: 1, now: 50_000 })
  expect(second).toMatchObject({ meetings: 1 })
  expect(second.stopped).toBeUndefined()
  expect(await store.cursor(1)).toBe("1970-01-01T00:00:50.000Z")

  await pull(source, store, { accountId: 1, now: 60_000, rescan: true })
  expect(asked.at(-1)).toBe(new Date(60_000 - 30 * 86400000).toISOString())
})

it("a source's overlap widens every pull's look-back, and a bad one is refused", async () => {
  const store = memoryMeetingStore()
  await store.setCursor(1, "1970-01-01T00:00:10.000Z", 10_000)
  const asked: string[] = []
  const meetings = async (since: string) => {
    asked.push(since)
    return []
  }
  await pull(fakeMeetingSource({ meetings, overlapMs: 4000 }), store, { accountId: 1, now: 20_000 })
  expect(asked).toEqual(["1970-01-01T00:00:06.000Z"])
  await expect(pull(fakeMeetingSource({ overlapMs: -1 }), store, { accountId: 1, now: 20_000 })).rejects.toThrow(
    /overlapMs/,
  )
})

it("returns no event for a meeting removed before linking", async () => {
  const store = memoryMeetingStore()
  const details = await store.saveMeeting(sampleMeeting())
  store.meeting = async () => null
  expect(await linkEvent(store, details)).toBeNull()
  expect(await store.events()).toEqual([])
})

it("late lookback does not advance the cursor when one revisited part fails", async () => {
  const store = memoryMeetingStore()
  await store.setCursor(1, "1970-01-01T00:00:02Z", 2000)
  const source = fakeMeetingSource({
    async summary() {
      throw new Error("Unavailable example summary")
    },
  })
  expect((await pull(source, store, { accountId: 1, now: 3000, lookbackMs: 1000 })).warnings).toHaveLength(1)
  expect(await store.cursor(1)).toBe("1970-01-01T00:00:02Z")
})

it("keeps the stored participant count when the participants read fails", async () => {
  const store = memoryMeetingStore()
  let broken = false
  const source = fakeMeetingSource({
    async participants() {
      if (broken) throw new Error("Unavailable example participants")
      const person = { email: null, externalId: null, role: null, joinedAt: null, leftAt: null, durationMs: null }
      return [
        { ...person, identityExternalId: "alice", displayName: "Alice Example", sessions: null, metadata: null },
        { ...person, identityExternalId: "bob", displayName: "Bob Sample", sessions: null, metadata: null },
      ]
    },
  })
  await pull(source, store, { accountId: 1, since: "1970-01-01T00:00:00Z", now: 2000 })
  expect((await store.meetings())[0]?.participantsCount).toBe(2)
  broken = true
  const report = await pull(source, store, { accountId: 1, since: "1970-01-01T00:00:00Z", now: 3000 })
  expect(report.warnings).toHaveLength(1)
  expect((await store.meetings())[0]?.participantsCount).toBe(2)
})
