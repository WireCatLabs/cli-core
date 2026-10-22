import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { sampleMeeting } from "../meetings/testing/index.js"
import { type MessageStore, openStore } from "../store/store.js"
import { searchMeetingsCombined } from "./meeting-combined.js"
import type { MeetingEmbedder } from "./meeting-model.js"
import { applyMeetingEmbedding } from "./meeting-semantic.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

// Each axis is one invented topic; a text points along every topic one of its words belongs to.
const TOPICS = [
  ["price", "pricing", "cost", "discount", "invoice"],
  ["hire", "hiring", "candidate", "interview"],
  ["flight", "hotel", "travel"],
]
const conceptual = (): MeetingEmbedder => ({
  key: "example:topics:4",
  model: "topics",
  dims: 4,
  kind: "remote",
  embed: async (texts) =>
    texts.map((text) => {
      const words = text.toLowerCase().match(/\p{L}+/gu) ?? []
      const vector = new Float32Array(4)
      TOPICS.forEach((topic, axis) => {
        vector[axis] = words.filter((word) => topic.includes(word)).length
      })
      vector[3] = 0.1
      const length = Math.hypot(...vector)
      return vector.map((value) => value / length)
    }),
  close: async () => {},
})

const fixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "zm-test-combined-")), "store.db") })
  stores.push(store)
  const accountId = await store.accounts.saveAccount(
    { provider: "example", account: "alice-example" },
    { name: "Alice Example" },
  )
  const meetings: Record<string, number> = {}
  for (const [name, startedAt, lines] of [
    ["pricing", 1000, ["We agreed the discount stays at ten percent.", "Bob Sample sends the invoice on Friday."]],
    ["hiring", 5000, ["The candidate interview moves to Tuesday.", "Hiring closes next month."]],
    ["travel", 9000, ["Book the flight and the hotel.", "Travel budget is fixed."]],
  ] as const) {
    const input = sampleMeeting()
    input.meeting.accountId = accountId
    input.meeting.externalId = `example-${name}`
    input.meeting.title = `Example ${name}`
    input.meeting.startedAt = startedAt
    input.meeting.endedAt = startedAt + 1000
    input.meeting.series = null
    input.transcripts[0].contentHash = `invented-${name}`
    input.transcripts[0].rows = lines.map((text, position) => ({
      ...input.transcripts[0].rows[0],
      position,
      startMs: position * 1000,
      endMs: position * 1000 + 1000,
      text,
    })) as (typeof input.transcripts)[0]["rows"]
    input.chat = [] as unknown as typeof input.chat
    input.summaries = []
    meetings[name] = (await store.meetings.saveMeeting(input)).meeting.id
  }
  await store.meetingVectors.rebuild({ accountId })
  const model = conceptual()
  await applyMeetingEmbedding(store.meetingVectors, accountId, model)
  return { store, accountId, meetings, model }
}

describe("combined meeting search", () => {
  it("answers a question by meaning when its words appear nowhere", async () => {
    const { store, accountId, meetings, model } = await fixture()
    const found = await searchMeetingsCombined(store, model, "what did we decide about the price?", { accountId })
    expect(found.words).toEqual({ query: "decide price", from: "question" })
    expect(found.items[0]).toMatchObject({ meetingId: meetings.pricing, by: ["meaning"], scope: "transcript" })
    expect(found.items[0]?.ref).toBe(found.items[0]?.passage?.first)
    expect(found.coverage).toMatchObject({ meaningScanComplete: true, scanned: 3 })
  })

  it("joins a word hit to the passage meaning found and cites the matching line", async () => {
    const { store, accountId, meetings, model } = await fixture()
    const found = await searchMeetingsCombined(store, model, "invoice", { accountId })
    expect(found.items[0]).toMatchObject({
      meetingId: meetings.pricing,
      by: ["words", "meaning"],
      text: "Bob Sample sends the invoice on Friday.",
      match: "words",
    })
    expect(found.items[0]?.ref).toMatch(/\/1$/)
    expect(found.items[0]?.score).toBeGreaterThan(0.9)
  })

  it("applies the meeting filters to meaning too", async () => {
    const { store, accountId, meetings, model } = await fixture()
    const found = await searchMeetingsCombined(store, model, "what about the price?", { accountId, since: 4000 })
    expect(found.items.map((hit) => hit.meetingId)).not.toContain(meetings.pricing)
    expect(found.coverage.scanned).toBe(2)
  })

  it("pages one ranking and refuses a cursor from another query", async () => {
    const { store, accountId, model } = await fixture()
    const first = await searchMeetingsCombined(store, model, "travel hiring", { accountId, limit: 1 })
    expect(first.hasMore).toBe(true)
    const next = await searchMeetingsCombined(store, model, "travel hiring", {
      accountId,
      limit: 1,
      after: first.nextCursor ?? undefined,
    })
    expect(next.items[0]?.ref).not.toBe(first.items[0]?.ref)
    await expect(
      searchMeetingsCombined(store, model, "price", { accountId, after: first.nextCursor ?? undefined }),
    ).rejects.toMatchObject({ code: "validation_error" })
  })

  it("asks by meaning alone when the query language refuses the text", async () => {
    const { store, accountId, meetings, model } = await fixture()
    const found = await searchMeetingsCombined(store, model, "price~2", { accountId })
    expect(found.words.refused).toBeDefined()
    expect(found.items[0]).toMatchObject({ meetingId: meetings.pricing, by: ["meaning"] })
  })

  it("puts a line with the words above a passage that only resembles the query, when they tie", async () => {
    const { store, accountId, meetings, model } = await fixture()
    const found = await searchMeetingsCombined(store, model, "flight", { accountId, maxChunks: 1 })
    expect(found.items.map((hit) => [hit.meetingId, hit.by])).toEqual([
      [meetings.travel, ["words"]],
      [meetings.pricing, ["meaning"]],
    ])
  })

  it("says when the vector budget stopped the scan", async () => {
    const { store, accountId, model } = await fixture()
    const found = await searchMeetingsCombined(store, model, "hotel", { accountId, maxChunks: 2 })
    expect(found.coverage).toMatchObject({ meaningScanComplete: false, scanned: 2 })
  })
})
