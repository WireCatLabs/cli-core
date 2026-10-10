import assert from "node:assert/strict"
import type { ContractCase, MeetingStore } from "../store.js"
import { sampleEvent, sampleMeeting } from "./samples.js"

/** Each case gets a fresh, empty store. The runner owns cleanup after run(). */
export const meetingStoreContract = (make: () => MeetingStore | Promise<MeetingStore>): ContractCase[] => {
  const test = (name: string, check: (store: MeetingStore) => Promise<void>): ContractCase => ({
    name,
    async run() {
      await check(await make())
    },
  })
  return [
    test("empty reads and account cursors", async (s) => {
      assert.deepEqual(await s.meetings(), [])
      assert.equal(await s.meeting(999), null)
      assert.deepEqual(await s.participants("Alice"), [])
      assert.deepEqual(await s.search("example"), [])
      assert.deepEqual(await s.search("  "), [])
      assert.deepEqual(await s.events(), [])
      assert.equal(await s.cursor(1), null)
      await s.setCursor(1, "first", 1)
      await s.setCursor(1, "second", 2)
      assert.equal(await s.cursor(1), "second")
      assert.equal(await s.cursor(2), null)
    }),
    test("atomic parts, ids and defensive snapshots", async (s) => {
      const input = sampleMeeting()
      const d = await s.saveMeeting(input)
      const p = d.participants[0]
      const t = d.transcripts[0]
      assert.ok(p)
      assert.ok(t)
      assert.equal(p.meetingId, d.meeting.id)
      assert.equal(t.transcript.meetingId, d.meeting.id)
      assert.equal(t.rows[0]?.speakerParticipantId, p.id)
      assert.equal(t.rows[0]?.meetingTranscriptId, t.transcript.id)
      assert.equal(d.chat[0]?.senderParticipantId, p.id)
      assert.equal(d.attachments[0]?.attachableId, d.meeting.id)
      assert.equal(d.meeting.createdAt, 3000)
      assert.equal(d.meeting.updatedAt, 3000)
      input.meeting.title = "Changed input"
      d.meeting.title = "Changed snapshot"
      const read = await s.meeting(d.meeting.id)
      assert.ok(read)
      assert.equal(read.meeting.title, "Example planning")
      read.meeting.title = "Changed read"
      assert.equal((await s.meeting(d.meeting.id))?.meeting.title, "Example planning")
      assert.equal((await s.participants("ALICE"))[0]?.id, p.id)
      assert.equal((await s.participants("example.com", 1)).length, 1)
      assert.equal((await s.participants("alice", 2)).length, 0)
      assert.deepEqual((await s.search("EXAMPLE")).map((h) => h.scope).sort(), ["chat", "summary", "transcript"])
      assert.equal((await s.search("Ship"))[0]?.startMs, 0)
    }),
    test("idempotence, updates and omitted parts retain history", async (s) => {
      const input = sampleMeeting()
      const first = await s.saveMeeting(input)
      input.now = 4000
      input.meeting.title = "Revised example"
      const again = await s.saveMeeting(input)
      assert.equal(again.meeting.id, first.meeting.id)
      assert.equal(again.series?.id, first.series?.id)
      assert.equal(again.meeting.createdAt, 3000)
      assert.equal(again.meeting.updatedAt, 4000)
      assert.equal(again.participants.length, 1)
      assert.equal(again.transcripts.length, 1)
      assert.equal(again.chat.length, 1)
      assert.equal(again.summaries.length, 1)
      assert.equal(again.attachments.length, 1)
      const missing = await s.saveMeeting({ meeting: input.meeting, now: 5000 })
      assert.equal(missing.transcripts.length, 1)
      assert.equal(missing.participants.length, 1)
      assert.equal(missing.chat.length, 1)
      assert.equal(missing.summaries.length, 1)
      assert.equal(missing.attachments.length, 1)
      const t = input.transcripts?.[0]
      assert.ok(t)
      t.contentHash = "new-invented-hash"
      t.rows[0].text = "Corrected text"
      const corrected = await s.saveMeeting(input)
      assert.equal(corrected.transcripts.length, 2)
      assert.equal(corrected.transcripts[0]?.transcript.supersededAt, 4000)
      assert.equal(corrected.transcripts[0]?.rows[0]?.text, "Ship the example plan.")
      assert.equal((await s.search("Ship")).length, 0)
      assert.equal((await s.search("Corrected")).length, 1)
      t.source = "file"
      t.contentHash = null
      t.rows[0].speakerParticipantPosition = null
      const other = await s.saveMeeting(input)
      assert.equal(other.transcripts.length, 3)
      assert.equal(other.transcripts[2]?.rows[0]?.speakerParticipantId, null)
    }),
    test("account keys, identities and same-time cues stay distinct", async (s) => {
      const input = sampleMeeting()
      const first = await s.saveMeeting(input)
      input.meeting.externalId = "second-occurrence"
      const t = input.transcripts?.[0]
      assert.ok(t)
      t.rows.push({ ...t.rows[0], position: 1 })
      const second = await s.saveMeeting(input)
      assert.notEqual(first.meeting.id, second.meeting.id)
      assert.equal(first.participants[0]?.identityId, second.participants[0]?.identityId)
      assert.equal(second.transcripts[0]?.rows.length, 2)
      input.meeting.accountId = 2
      const third = await s.saveMeeting(input)
      assert.notEqual(second.meeting.id, third.meeting.id)
      assert.notEqual(second.series?.id, third.series?.id)
      input.participants[0].identity.externalId = "another-alice"
      input.meeting.externalId = "third-occurrence"
      const clash = await s.saveMeeting(input)
      assert.notEqual(clash.participants[0]?.identityId, third.participants[0]?.identityId)
    }),
    test("filters, ordering, paging and soft deletion", async (s) => {
      const input = sampleMeeting()
      const first = await s.saveMeeting(input)
      input.meeting.externalId = "later"
      input.meeting.startedAt = 2500
      const later = await s.saveMeeting(input)
      input.meeting.externalId = "deleted"
      input.meeting.deletedAt = 5000
      await s.saveMeeting(input)
      input.meeting.externalId = "unknown-time"
      input.meeting.startedAt = null
      input.meeting.deletedAt = null
      delete input.meeting.series
      const unknown = await s.saveMeeting(input)
      assert.equal(unknown.series, null)
      assert.deepEqual(
        (await s.meetings({ since: 2000 })).map((m) => m.id),
        [later.meeting.id],
      )
      assert.deepEqual(
        (await s.meetings({ until: 2000 })).map((m) => m.id),
        [first.meeting.id],
      )
      assert.equal((await s.meetings({ includeDeleted: true })).length, 4)
      assert.equal((await s.meetings({ accountId: 2 })).length, 0)
      assert.ok(first.series)
      assert.equal((await s.meetings({ meetingSeriesId: first.series.id })).length, 2)
      assert.equal((await s.meetings({ eventId: 999 })).length, 0)
      assert.deepEqual(
        (await s.meetings({ limit: 1, offset: 1 })).map((m) => m.id),
        [first.meeting.id],
      )
      assert.deepEqual(await s.meetings({ limit: 0 }), [])
      await assert.rejects(s.meetings({ limit: -1 }))
      await assert.rejects(s.meetings({ offset: 0.5 }))
    }),
    test("events, series, matching and owner links", async (s) => {
      const d = await s.saveMeeting(sampleMeeting())
      assert.ok(d.series)
      const es = await s.createEventSeries({ title: "Example series", recurrence: null, origin: "auto" }, 3000)
      await s.setEventSeries(d.series.id, es.id, 4000)
      const a = await s.createEvent({ ...sampleEvent(), eventSeriesId: es.id }, 3000)
      const b = await s.createEvent(sampleEvent(), 3000)
      await s.linkMeeting(d.meeting.id, b.id, 4000)
      const filter = { meetingSeriesId: d.series.id, joinUrl: "https://example.com/room", startsAt: 1500, endsAt: 1800 }
      assert.deepEqual((await s.eventCandidates(filter)).map((e) => e.id).sort(), [a.id, b.id].sort())
      assert.equal((await s.eventCandidates({ ...filter, startsAt: 5000, endsAt: 6000 })).length, 0)
      assert.equal((await s.eventCandidates({ ...filter, meetingSeriesId: null, joinUrl: null })).length, 0)
      await s.linkMeeting(d.meeting.id, a.id, 5000)
      assert.equal((await s.meeting(d.meeting.id))?.meeting.eventId, b.id)
      await s.linkMeeting(d.meeting.id, a.id, 5000, "owner")
      assert.equal((await s.meeting(d.meeting.id))?.meeting.eventId, a.id)
      const updated = await s.saveMeeting(sampleMeeting())
      assert.equal(updated.meeting.eventId, a.id)
      assert.equal(updated.series?.eventSeriesId, es.id)
      assert.equal((await s.meetings({ eventId: a.id })).length, 1)
      await s.createEvent({ ...sampleEvent(), deletedAt: 1 }, 3000)
      assert.equal((await s.events()).length, 2)
      await assert.rejects(s.linkMeeting(999, a.id, 1))
      await assert.rejects(s.linkMeeting(d.meeting.id, 999, 1))
      await assert.rejects(s.setEventSeries(999, es.id, 1))
      await assert.rejects(s.setEventSeries(d.series.id, 999, 1))
      await assert.rejects(s.createEvent({ ...sampleEvent(), eventSeriesId: 999 }, 1))
    }),
    test("failed saves leave no partial changes", async (s) => {
      const input = sampleMeeting()
      const before = await s.saveMeeting(input)
      input.meeting.title = "Should roll back"
      input.transcripts[0].contentHash = "invalid-version"
      input.transcripts[0].rows[0].speakerParticipantPosition = 99
      await assert.rejects(s.saveMeeting(input))
      assert.deepEqual(await s.meeting(before.meeting.id), before)
      input.transcripts[0].rows[0].speakerParticipantPosition = 0
      input.transcripts[0].rows.push({ ...input.transcripts[0].rows[0] })
      await assert.rejects(s.saveMeeting(input))
      assert.deepEqual(await s.meeting(before.meeting.id), before)
      input.transcripts[0].rows = [{ ...input.transcripts[0].rows[0], position: -1 }]
      await assert.rejects(s.saveMeeting(input))
      const invalid = sampleMeeting()
      invalid.meeting.accountId = 0
      await assert.rejects(s.saveMeeting(invalid))
      invalid.meeting.accountId = 1
      invalid.meeting.externalId = ""
      await assert.rejects(s.saveMeeting(invalid))
      const badIdentity = sampleMeeting()
      badIdentity.participants[0].identity.externalId = ""
      await assert.rejects(s.saveMeeting(badIdentity))
    }),
    test("chat without external ids deduplicates and updates named ids", async (s) => {
      const input = sampleMeeting()
      input.chat[0].externalId = null
      input.chat[0].senderParticipantPosition = null
      const first = await s.saveMeeting(input)
      assert.equal(first.chat[0]?.senderParticipantId, null)
      assert.equal((await s.saveMeeting(input)).chat.length, 1)
      input.chat[0].text = "Another example"
      assert.equal((await s.saveMeeting(input)).chat.length, 2)
      input.chat[0].externalId = "stable-chat"
      await s.saveMeeting(input)
      input.chat[0].text = "Edited example"
      const d = await s.saveMeeting(input)
      assert.equal(d.chat.length, 3)
      assert.equal(d.chat[2]?.text, "Edited example")
      input.chat[0].senderParticipantPosition = 99
      await assert.rejects(s.saveMeeting(input))
      const noNames = sampleMeeting()
      noNames.meeting.externalId = "nameless"
      noNames.participants[0].displayName = null
      noNames.participants[0].email = null
      await s.saveMeeting(noNames)
      assert.equal((await s.participants("alice")).length, 1)
    }),
  ]
}
