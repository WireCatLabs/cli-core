import { expect, it } from "vitest"
import { linkEvent } from "./events.js"
import { callMeetingTool } from "./mcp/index.js"
import { pull } from "./pull.js"
import { meetingsList, meetingsSearch } from "./reads.js"
import { fakeMeetingSource, memoryMeetingStore, sampleEvent, sampleMeeting } from "./testing/index.js"

it("does not expose arbitrary store exception text through MCP", async () => {
  const store = memoryMeetingStore()
  store.meetings = async () => {
    throw new Error("Invented confidential meeting text")
  }
  const result = await callMeetingTool(store, "meetings_list", {})
  expect(result.structuredContent).toEqual({ error: { code: "generic_failure", message: "Meeting read failed" } })
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
  await expect(meetingsList(store, { limit: 3 }, Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({
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
