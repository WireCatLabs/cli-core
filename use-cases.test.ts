import { describe, expect, it } from "vitest"
import { linkEvent } from "./events.js"
import { importFiles } from "./import.js"
import { contentHash, speakerPosition, timestamp } from "./ingest.js"
import { pull } from "./pull.js"
import type { SourceParticipant } from "./source.js"
import { fakeMeetingSource, memoryMeetingStore, sampleEvent, sampleMeeting } from "./testing/index.js"

const participant = (overrides: Partial<SourceParticipant> = {}): SourceParticipant => ({
  identityExternalId: "alice",
  displayName: "Alice Example",
  email: null,
  externalId: null,
  role: "host",
  joinedAt: null,
  leftAt: null,
  durationMs: null,
  sessions: null,
  metadata: null,
  ...overrides,
})
const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAlice Example: Example plan\n"
const options = { accountId: 1, since: "1970-01-01T00:00:00.000Z", now: 4000 }

describe("pull", () => {
  it("fetches parts in order, resolves speakers and skips duplicate transcript versions", async () => {
    const calls: string[] = []
    const source = fakeMeetingSource({
      async participants() {
        calls.push("participants")
        return [participant()]
      },
      async transcript() {
        calls.push("transcript")
        return [{ startMs: 0, endMs: 1000, speaker: "Alice Example", text: "Example" }]
      },
      async chat() {
        calls.push("chat")
        return [{ sentAt: "1970-01-01T00:00:01.000Z", sender: "Alice Example", text: "Example chat" }]
      },
      async summary() {
        calls.push("summary")
        return { title: null, overview: "Example", sections: [], nextSteps: [] }
      },
      async files() {
        calls.push("files")
        return sampleMeeting().attachments ?? []
      },
    })
    const store = memoryMeetingStore()
    const report = await pull(source, store, options)
    expect(calls).toEqual(["participants", "transcript", "chat", "summary", "files"])
    expect(report).toMatchObject({ meetings: 1, participants: 1, transcriptRows: 1, summaries: 1, warnings: [] })
    const [m] = await store.meetings()
    expect(m).toBeDefined()
    const d = await store.meeting(m?.id ?? 0)
    expect(d?.transcripts[0]?.rows[0]?.speakerParticipantId).toBe(d?.participants[0]?.id)
    expect(d?.meeting.eventId).not.toBeNull()
    expect(d?.attachments.length).toBe(1)
    await pull(source, store, options)
    expect((await store.meeting(m?.id ?? 0))?.transcripts.length).toBe(1)
    expect(await store.cursor(1)).toBe("1970-01-01T00:00:04.000Z")
  })
  it("keeps ambiguous names without guessing and warns", async () => {
    const source = fakeMeetingSource({
      async participants() {
        return [participant(), participant({ identityExternalId: "bob" })]
      },
    })
    const store = memoryMeetingStore()
    const report = await pull(source, store, options)
    expect(report.warnings[0]?.message).toMatch(/ambiguous/)
    const [m] = await store.meetings()
    const d = await store.meeting(m?.id ?? 0)
    expect(d?.transcripts[0]?.rows[0]?.speakerParticipantId).toBeNull()
    expect(d?.transcripts[0]?.rows[0]?.speakerName).toBe("Alice Example")
    expect(await store.cursor(1)).not.toBeNull()
  })
  it("uses email, participant ids and meeting-local names as identity fallbacks", async () => {
    const store = memoryMeetingStore()
    await pull(
      fakeMeetingSource({
        async participants() {
          return [
            participant({ identityExternalId: null, email: "alice@example.com" }),
            participant({ identityExternalId: null, externalId: "registrant-example", displayName: null }),
            participant({ identityExternalId: null, displayName: "Bob Sample" }),
            participant({ identityExternalId: null, displayName: null }),
          ]
        },
      }),
      store,
      options,
    )
    expect((await store.participants("")).length).toBe(4)
  })
  it("continues after an occurrence fails and retains the cursor for retry", async () => {
    const source = fakeMeetingSource()
    const base = (await source.meetings(""))[0]
    expect(base).toBeDefined()
    if (!base) throw new Error("Missing fake meeting")
    const store = memoryMeetingStore()
    await store.setCursor(1, options.since, 0)
    source.meetings = async () => [{ ...base, occurrence: { ...base.occurrence, id: "failed" } }, base]
    source.participants = async (id) => {
      if (id === "failed") throw new Error("Unavailable participants")
      return null
    }
    const report = await pull(source, store, { accountId: 1, now: 4000 })
    expect(report.meetings).toBe(1)
    expect(report.warnings[0]?.externalId).toBe("failed")
    expect(await store.cursor(1)).toBe(options.since)
    source.participants = async () => {
      throw "unavailable"
    }
    expect((await pull(source, store, options)).warnings[0]?.message).toBe("Meeting pull failed")
  })
  it("handles unavailable parts, no series, defaults and invalid timestamps", async () => {
    const source = fakeMeetingSource()
    const base = (await source.meetings(""))[0]
    if (!base) throw new Error("Missing fake meeting")
    source.meetings = async (since) => {
      expect(Date.parse(since)).toBeLessThan(Date.now())
      return [
        {
          ...base,
          series: null,
          description: "Example agenda",
          location: "Example room",
          joinUrl: "https://example.com/room",
          timezone: "UTC",
          metadata: {},
          occurrence: { ...base.occurrence, endedAt: null },
        },
      ]
    }
    source.transcript = async () => null
    const store = memoryMeetingStore()
    expect((await pull(source, store, { accountId: 1 })).meetings).toBe(1)
    const [m] = await store.meetings()
    expect(m?.durationMs).toBeNull()
    source.meetings = async () => [{ ...base, occurrence: { ...base.occurrence, startedAt: "bad" } }]
    expect((await pull(source, store, options)).warnings[0]?.message).toMatch(/timestamp/)
    await expect(pull(source, store, { ...options, since: "bad" })).rejects.toThrow(/timestamp/)
    source.meetings = async () => {
      throw new Error("List failure")
    }
    await expect(pull(source, store, options)).rejects.toThrow("List failure")
  })
})
describe("import", () => {
  it("parses in-memory files, keeps unmatched speakers and preserves transcript versions", async () => {
    const store = memoryMeetingStore()
    const meeting = sampleMeeting().meeting
    const file = { meeting, content: vtt }
    expect((await importFiles([file], store, 4000)).meetings).toBe(1)
    await importFiles([file], store)
    const [m] = await store.meetings()
    expect((await store.meeting(m?.id ?? 0))?.transcripts.length).toBe(1)
    await importFiles(
      [
        {
          ...file,
          content: vtt.replace("Example plan", "Corrected example"),
          participants: sampleMeeting().participants,
          source: "file",
        },
      ],
      store,
      5000,
    )
    const d = await store.meeting(m?.id ?? 0)
    expect(d?.transcripts.length).toBe(2)
    expect(d?.transcripts[0]?.rows[0]?.speakerParticipantId).toBeNull()
    expect(d?.transcripts[1]?.rows[0]?.speakerParticipantId).toBe(d?.participants[0]?.id)
    expect(await contentHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })
  it("reports a broken file and continues; handles non-Error store failures", async () => {
    const store = memoryMeetingStore()
    const meeting = sampleMeeting().meeting
    const result = await importFiles(
      [
        { meeting, content: "broken" },
        { meeting, content: vtt },
      ],
      store,
    )
    expect(result.meetings).toBe(1)
    expect(result.warnings.length).toBe(1)
    store.saveMeeting = async () => {
      throw "failure"
    }
    expect((await importFiles([{ meeting, content: vtt }], store)).warnings[0]?.message).toBe("Meeting import failed")
  })
})
describe("events", () => {
  it("creates recurring event series once, preserves links and matches overlapping occurrences", async () => {
    const store = memoryMeetingStore()
    const input = sampleMeeting()
    const first = await store.saveMeeting(input)
    const event = await linkEvent(store, first, 4000)
    expect(event?.eventSeriesId).not.toBeNull()
    const linked = await store.meeting(first.meeting.id)
    if (!linked) throw new Error("Missing meeting")
    expect((await linkEvent(store, linked))?.id).toBe(event?.id)
    input.meeting.externalId = "another-source-record"
    const second = await store.saveMeeting(input)
    expect((await linkEvent(store, second))?.id).toBe(event?.id)
    const owner = await store.createEvent({ ...sampleEvent(), origin: "owner" }, 5000)
    await store.linkMeeting(first.meeting.id, owner.id, 5000, "owner")
    expect((await linkEvent(store, await store.saveMeeting(input)))?.id).toBe(event?.id)
  })
  it("creates an event for unknown time and avoids guessing between candidates", async () => {
    const store = memoryMeetingStore()
    const input = sampleMeeting()
    input.meeting.startedAt = null
    const d = await store.saveMeeting(input)
    expect(await linkEvent(store, d)).not.toBeNull()
    await store.createEvent(sampleEvent(), 1)
    await store.createEvent(sampleEvent(), 1)
    store.eventCandidates = async () => await store.events()
    input.meeting.externalId = "ambiguous"
    input.meeting.startedAt = 1000
    input.meeting.endedAt = null
    delete input.meeting.series
    const another = await store.saveMeeting(input)
    const created = await linkEvent(store, another)
    expect(created?.id).not.toBe(d.meeting.eventId)
    expect((await store.events()).length).toBe(4)
    another.meeting.eventId = 999
    expect(await linkEvent(store, another)).toBeNull()
  })
})
it("speaker matching accepts only one match", () => {
  const participants = sampleMeeting().participants
  expect(speakerPosition(null, participants)).toBeNull()
  expect(speakerPosition("Missing", participants)).toBeNull()
  expect(speakerPosition("Alice Example", [participants[0], participants[0]])).toBeNull()
  expect(timestamp("1970-01-01T00:00:00Z")).toBe(0)
})

it("rejects reversed times and isolates fallback names across accounts", async () => {
  const source = fakeMeetingSource()
  const base = (await source.meetings(""))[0]
  if (!base) throw new Error("Missing fake meeting")
  source.meetings = async () => [{ ...base, occurrence: { ...base.occurrence, endedAt: "1970-01-01T00:00:00Z" } }]
  expect((await pull(source, memoryMeetingStore(), options)).warnings[0]?.message).toMatch(/ends before/)
  source.meetings = async () => [base]
  source.participants = async () => [participant({ identityExternalId: null })]
  const store = memoryMeetingStore()
  await pull(source, store, options)
  await pull(source, store, { ...options, accountId: 2 })
  const people = await store.participants("Alice")
  expect(people[0]?.identityId).not.toBe(people[1]?.identityId)
  expect(people[0]).not.toHaveProperty("identityExternalId")
})
