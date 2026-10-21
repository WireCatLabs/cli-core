import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { MeetingSave } from "../meetings/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close()
})
const START = Date.parse("2026-10-21T10:00:00Z")
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-one-record-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path }, now: () => 1000 })
  opened.push(store)
  const accountId = await store.accounts.saveAccount(
    { provider: "example", account: "AliceExample" },
    { name: "Alice Example" },
  )
  const copy = (
    externalId: string,
    {
      source,
      text,
      startedAt = START,
      series = "84400000000",
    }: { source: string; text: string; startedAt?: number; series?: string },
  ): MeetingSave => {
    const input = sampleMeeting()
    input.meeting.accountId = accountId
    input.meeting.externalId = externalId
    input.meeting.startedAt = startedAt
    input.meeting.title = source === "file" ? "planerka" : "Планёрка"
    if (input.meeting.series) input.meeting.series.externalId = series
    input.transcripts[0].source = source
    input.transcripts[0].contentHash = `${source}-${text}`
    input.transcripts[0].rows[0].text = text
    return { ...input, chat: [], summaries: [], now: 1000, ...(source === "file" ? { fromFile: true } : {}) }
  }
  const meetings = async () => store.meetings.meetings({ accountId })
  const transcripts = async (id: number) =>
    ((await store.meetings.meeting(id))?.transcripts ?? [])
      .filter(({ transcript }) => transcript.supersededAt === null)
      .map(({ transcript, rows }) => [transcript.source, rows[0]?.text])
  return { store, copy, meetings, transcripts }
}

it("lets the provider's copy take over a meeting first imported from a file", async () => {
  const { store, copy, meetings, transcripts } = await fixture()
  await store.meetings.saveMeeting(copy("file:abc", { source: "file", text: "Из файла" }))
  await store.meetings.saveMeeting(copy("uuid-1", { source: "api", text: "Из Zoom", startedAt: START + 5 * 60_000 }))
  const [only, ...rest] = await meetings()
  expect(rest).toEqual([])
  expect([only?.externalId, only?.title]).toEqual(["uuid-1", "Планёрка"])
  expect(await transcripts(only?.id ?? 0)).toEqual([["api", "Из Zoom"]])
})

it("keeps the provider's record when the file comes second, and fills only a missing transcript", async () => {
  const { store, copy, meetings, transcripts } = await fixture()
  const api = copy("uuid-1", { source: "api", text: "Из Zoom" })
  await store.meetings.saveMeeting({ ...api, transcripts: [] })
  await store.meetings.saveMeeting(
    copy("file:abc", { source: "file", text: "Из файла", startedAt: START - 10 * 60_000 }),
  )
  let [only, ...rest] = await meetings()
  expect(rest).toEqual([])
  expect([only?.externalId, only?.title]).toEqual(["uuid-1", "Планёрка"])
  expect(await transcripts(only?.id ?? 0)).toEqual([["file", "Из файла"]])

  await store.meetings.saveMeeting(api)
  await store.meetings.saveMeeting(copy("file:abc", { source: "file", text: "Из файла, правка" }))
  ;[only, ...rest] = await meetings()
  expect(rest).toEqual([])
  expect(await transcripts(only?.id ?? 0)).toEqual([["api", "Из Zoom"]])
})

it("keeps occurrences apart when the series differs, the starts are far apart, or both come from the provider", async () => {
  const { store, copy, meetings } = await fixture()
  await store.meetings.saveMeeting(copy("uuid-1", { source: "api", text: "Первая" }))
  await store.meetings.saveMeeting(copy("file:other-series", { source: "file", text: "Файл", series: "file:planerka" }))
  await store.meetings.saveMeeting(
    copy("file:next-day", { source: "file", text: "Файл", startedAt: START + 86_400_000 }),
  )
  await store.meetings.saveMeeting(copy("uuid-2", { source: "api", text: "Перезапуск", startedAt: START + 3 * 60_000 }))
  expect((await meetings()).map((meeting) => meeting.externalId).sort()).toEqual([
    "file:next-day",
    "file:other-series",
    "uuid-1",
    "uuid-2",
  ])
})
