import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { sampleMeeting } from "../meetings/testing/index.js"
import { type MessageStore, openStore } from "../store/store.js"
import { readMeetingLinks } from "./meeting-links.js"
import { readMeetingReview } from "./meeting-review.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const DAY = 86_400_000
const MONDAY = Date.UTC(2026, 9, 19, 10)

const fixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "cli-test-review-")), "store.db") })
  stores.push(store)
  const accountId = await store.accounts.saveAccount({ provider: "example", account: "alice-example" }, { name: "A" })
  const save = async (name: string, startedAt: number, extra: (input: ReturnType<typeof sampleMeeting>) => void) => {
    const input = sampleMeeting()
    input.meeting.accountId = accountId
    input.meeting.externalId = `example-${name}`
    input.meeting.title = `Example ${name}`
    input.meeting.startedAt = startedAt
    delete input.meeting.series
    input.transcripts[0].contentHash = `invented-${name}`
    extra(input)
    await store.meetings.saveMeeting(input)
  }
  await save("planning", MONDAY, (input) => {
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
    input.summaries = [
      {
        source: "zoom",
        title: "Example planning",
        overview: "The team agreed the example plan.",
        sections: [],
        nextSteps: ["Alice sends the example draft"],
        content: null,
        docUrl: null,
        externalCreatedAt: null,
        externalUpdatedAt: null,
        metadata: {},
      },
    ]
  })
  await save("silent", MONDAY + 2 * DAY, (input) => {
    input.transcripts = [] as never
    input.summaries = []
  })
  return { store, accountId }
}

it("shows the newest meetings with their summary, transcript size and who talked longest", async () => {
  const { store, accountId } = await fixture()
  const review = await readMeetingReview(store, { accountId })
  expect(review.hasMore).toBe(false)
  expect(review.items.map((one) => one.title)).toEqual(["Example silent", "Example planning"])
  const [silent, planning] = review.items
  expect(silent).toMatchObject({ transcript: null, summary: null, speakers: [] })
  expect(planning).toMatchObject({
    transcript: { lines: 2, words: 6 },
    speakers: [
      { name: "Alice Example", talkMs: 4000 },
      { name: "Bob Sample", talkMs: 1000 },
    ],
    summary: { overview: "The team agreed the example plan.", nextSteps: ["Alice sends the example draft"] },
  })
})

it("keeps to the selection and says when more meetings match than it shows", async () => {
  const { store, accountId } = await fixture()
  expect((await readMeetingReview(store, { accountId, since: MONDAY + DAY })).items.map((one) => one.title)).toEqual([
    "Example silent",
  ])
  const first = await readMeetingReview(store, { accountId, limit: 1 })
  expect(first).toMatchObject({ hasMore: true, items: [{ title: "Example silent" }] })
  await expect(readMeetingReview(store, { accountId, limit: 201 })).rejects.toMatchObject({ code: "validation_error" })
})

it("lists links shared in meeting chat, most shared first, with who shared them and where", async () => {
  const { store, accountId } = await fixture()
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  input.meeting.externalId = "example-links"
  input.meeting.title = "Example links"
  input.meeting.startedAt = MONDAY + 4 * DAY
  delete input.meeting.series
  input.transcripts[0].contentHash = "invented-links"
  const line = input.chat[0]
  input.chat = [
    {
      ...line,
      externalId: "example-1",
      sentAt: MONDAY + 4 * DAY,
      text: "Plan: https://example.com/plan?utm_source=x.",
    },
    {
      ...line,
      externalId: "example-2",
      sentAt: MONDAY + 4 * DAY + 60_000,
      senderParticipantPosition: null,
      senderName: "Bob Sample",
      text: "Again https://example.com/plan and https://docs.google.com/document/d/EXAMPLEdocumentId123/edit",
    },
  ] as typeof input.chat
  await store.meetings.saveMeeting(input)
  const links = await readMeetingLinks(store, { accountId })
  expect(links).toMatchObject({ messages: 4, meetings: 3 })
  expect(links.items.map(({ url, count, senders, documentId }) => ({ url, count, senders, documentId }))).toEqual([
    { url: "https://example.com/plan", count: 2, senders: ["Alice Example", "Bob Sample"], documentId: null },
    {
      url: "https://docs.google.com/document/d/EXAMPLEdocumentId123/edit",
      count: 1,
      senders: ["Bob Sample"],
      documentId: "EXAMPLEdocumentId123",
    },
  ])
  expect(links.items[0]?.meetings.map((one) => one.title)).toEqual(["Example links"])
  await expect(readMeetingLinks(store, { accountId, maxMessages: 3 })).rejects.toMatchObject({
    code: "validation_error",
  })
})
