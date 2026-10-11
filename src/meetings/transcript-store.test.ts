import { expect, it } from "vitest"
import { memoryMeetingStore, sampleMeeting } from "./testing/index.js"
import { meetingTranscriptStoreContract } from "./testing/transcript-contract.js"
import type { TranscriptAppend } from "./transcript-store.js"

for (const test of meetingTranscriptStoreContract(memoryMeetingStore)) it(test.name, test.run)

it("refuses invalid keys, starts, duplicate sources, empty hashes and participant guesses before any write", async () => {
  const store = memoryMeetingStore()
  const original = await store.saveMeeting(sampleMeeting())
  const { rows, ...fields } = sampleMeeting().transcripts[0]
  const { speakerParticipantPosition: _position, ...row } = rows[0]
  const valid: TranscriptAppend = {
    accountId: 1,
    externalId: "example-occurrence",
    now: 5000,
    transcripts: [{ ...fields, source: "asset", contentHash: "hash", rows: [row] }],
  }
  const first = valid.transcripts[0]
  expect(first).toBeDefined()
  if (!first) throw new Error("missing fixture")
  for (const change of [
    { accountId: 0 },
    { externalId: " " },
    { now: 1.5 },
    { transcripts: [] },
    { create: { title: null, startedAt: Number.NaN, timezone: null } },
    { create: { title: null, startedAt: 8640000000000001, timezone: null } },
    { transcripts: [{ ...first, source: " " }] },
    { transcripts: [{ ...first, contentHash: " " }] },
    { transcripts: [first, first] },
    { transcripts: [{ ...first, rows: [{ ...row, speakerParticipantPosition: 0 }] }] },
    { transcripts: [{ ...first, rows: [{ ...row, speakerParticipantId: 999 }] }] },
  ]) {
    await expect(store.appendTranscripts({ ...valid, ...change })).rejects.toThrow()
    expect(await store.meeting(original.meeting.id)).toEqual(original)
  }
})
