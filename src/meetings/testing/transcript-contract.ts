import assert from "node:assert/strict"
import type { ContractCase, MeetingStore } from "../store.js"
import type { MeetingTranscriptStore, TranscriptAppend, UnlinkedTranscriptInput } from "../transcript-store.js"
import { sampleEvent, sampleMeeting } from "./samples.js"

const transcript = (source = "example-asset", hash = "example-hash"): UnlinkedTranscriptInput => {
  const original = sampleMeeting().transcripts[0]
  return {
    ...original,
    source,
    contentHash: hash,
    rows: original.rows.map(({ speakerParticipantPosition: _position, ...row }) => row),
  }
}
const request = (transcripts = [transcript()]): TranscriptAppend => ({
  accountId: 1,
  externalId: "example-occurrence",
  transcripts,
  now: 5000,
})

/** Optional capability cases; factory must also provide the unchanged meeting port. */
export const meetingTranscriptStoreContract = (
  make: () => (MeetingStore & MeetingTranscriptStore) | Promise<MeetingStore & MeetingTranscriptStore>,
): ContractCase[] => {
  const test = (
    name: string,
    check: (store: MeetingStore & MeetingTranscriptStore) => Promise<void>,
  ): ContractCase => ({
    name,
    async run() {
      await check(await make())
    },
  })
  return [
    test("append requires an existing occurrence or explicit real start", async (store) => {
      await assert.rejects(store.appendTranscripts(request()))
      assert.deepEqual(await store.meetings(), [])
      const appended = await store.appendTranscripts({
        ...request(),
        create: { title: "Example archive", startedAt: 1000, timezone: "UTC" },
      })
      assert.equal(appended.meeting.externalId, "example-occurrence")
      assert.equal(appended.meeting.accountId, 1)
      assert.equal(appended.meeting.startedAt, 1000)
      assert.equal(appended.meeting.eventId, null)
      assert.equal(appended.series, null)
      assert.deepEqual(appended.participants, [])
      assert.equal(appended.transcripts[0]?.rows[0]?.speakerParticipantId, null)
      assert.equal(appended.transcripts[0]?.rows[0]?.speakerName, "Alice Example")
      assert.deepEqual(await store.events(), [])
      assert.equal(await store.cursor(1), null)
    }),
    test("append preserves owner scalars, links, other parts and cursor", async (store) => {
      const original = await store.saveMeeting(sampleMeeting())
      const event = await store.createEvent(sampleEvent(), 4000)
      await store.linkMeeting(original.meeting.id, event.id, 4000, "owner")
      await store.setCursor(1, "owner-cursor", 4000)
      const before = await store.meeting(original.meeting.id)
      assert.ok(before)
      const appended = await store.appendTranscripts({
        ...request(),
        create: { title: "Stale provider title", startedAt: 1, timezone: null },
      })
      assert.deepEqual(appended.meeting, before.meeting)
      assert.deepEqual(appended.series, before.series)
      for (const field of ["participants", "chat", "summaries", "attachments"] as const)
        assert.deepEqual(appended[field], before[field])
      assert.deepEqual(appended.transcripts[0], before.transcripts[0])
      assert.equal(appended.transcripts.length, 2)
      assert.equal(await store.cursor(1), "owner-cursor")
      assert.deepEqual(await store.events(), [event])
    }),
    test("source hashes are idempotent and sibling revisions remain independent", async (store) => {
      await store.saveMeeting(sampleMeeting())
      const first = await store.appendTranscripts(request([transcript("asset-one"), transcript("asset-two")]))
      assert.equal(first.transcripts.length, 3)
      const repeat = await store.appendTranscripts({
        ...request([transcript("asset-one"), transcript("asset-two")]),
        now: 6000,
      })
      assert.deepEqual(repeat, first)
      const corrected = transcript("asset-one", "corrected-hash")
      const correctedRow = corrected.rows[0]
      assert.ok(correctedRow)
      correctedRow.text = "Corrected example"
      const changed = await store.appendTranscripts({ ...request([corrected]), now: 7000 })
      assert.equal(changed.transcripts.length, 4)
      assert.equal(
        changed.transcripts.find((item) => item.transcript.source === "asset-one")?.transcript.supersededAt,
        7000,
      )
      assert.equal(
        changed.transcripts.find((item) => item.transcript.source === "asset-two")?.transcript.supersededAt,
        null,
      )
      assert.equal(changed.transcripts[0]?.transcript.supersededAt, null)
      assert.equal(changed.transcripts.at(-1)?.rows[0]?.text, "Corrected example")
      const historicalReplay = await store.appendTranscripts(request([transcript("asset-one")]))
      assert.deepEqual(historicalReplay, changed)
    }),
    test("matching UUIDs remain isolated across accounts and deleted targets stay deleted", async (store) => {
      const original = sampleMeeting()
      const first = await store.saveMeeting(original)
      original.meeting.accountId = 2
      const other = await store.saveMeeting(original)
      await store.appendTranscripts(request())
      assert.deepEqual(await store.meeting(other.meeting.id), other)
      original.meeting.accountId = 1
      original.meeting.deletedAt = 6000
      await store.saveMeeting(original)
      const deleted = await store.meeting(first.meeting.id)
      await assert.rejects(
        store.appendTranscripts({ ...request(), create: { title: null, startedAt: 1, timezone: null } }),
      )
      assert.deepEqual(await store.meeting(first.meeting.id), deleted)
    }),
    test("a later invalid asset rolls back the whole batch", async (store) => {
      const original = await store.saveMeeting(sampleMeeting())
      const bad = transcript("bad-asset")
      const badRow = bad.rows[0]
      assert.ok(badRow)
      badRow.position = -1
      await assert.rejects(store.appendTranscripts(request([transcript(), bad])))
      assert.deepEqual(await store.meeting(original.meeting.id), original)
      const after = await store.appendTranscripts(request())
      assert.equal(after.transcripts.length, 2)
    }),
    test("extra creation fields cannot redirect occurrence identity", async (store) => {
      const foreign = sampleMeeting()
      foreign.meeting.accountId = 2
      const existing = await store.saveMeeting(foreign)
      const create = {
        title: "Example archive",
        startedAt: 1000,
        timezone: "UTC",
        accountId: 2,
        externalId: existing.meeting.externalId,
      }
      const appended = await store.appendTranscripts({ ...request(), externalId: "new-occurrence", create })
      assert.equal(appended.meeting.accountId, 1)
      assert.equal(appended.meeting.externalId, "new-occurrence")
      assert.deepEqual(await store.meeting(existing.meeting.id), existing)
    }),
    test("inputs and returned snapshots cannot mutate stored parts", async (store) => {
      await store.saveMeeting(sampleMeeting())
      const input = request()
      const result = await store.appendTranscripts(input)
      const inputRow = input.transcripts[0]?.rows[0]
      const resultRow = result.transcripts[1]?.rows[0]
      assert.ok(inputRow)
      assert.ok(resultRow)
      inputRow.text = "Mutated input"
      resultRow.text = "Mutated result"
      const stored = await store.meeting(result.meeting.id)
      assert.equal(stored?.transcripts[1]?.rows[0]?.text, "Ship the example plan.")
    }),
  ]
}
