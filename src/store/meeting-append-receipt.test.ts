import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { afterEach, expect, it } from "vitest"
import { MeetingError, transcribeMeeting } from "../meetings/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close()
})
it("reports creation, correction and historical replay from the same atomic append", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-append-receipt-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path } })
  opened.push(store)
  const accountId = await store.accounts.saveAccount(
    { provider: "example", account: "AliceExample" },
    { name: "Alice Example" },
  )
  const original = sampleMeeting().transcripts[0]
  const transcript = {
    ...original,
    contentHash: "original-AliceExample",
    rows: original.rows.map(({ speakerParticipantPosition: _position, ...row }) => row),
  }
  const input = {
    accountId,
    externalId: "AliceExample-occurrence",
    now: 1000,
    create: { title: "Alice Example planning", startedAt: 1000, timezone: null },
    transcripts: [transcript],
  }
  expect(await store.meetings.appendTranscriptsWithReceipt(input)).toMatchObject({
    created: true,
    insertedTranscripts: 1,
    replayedTranscripts: 0,
    supersededTranscripts: 0,
  })
  const other = await openStore({ path, env: { MESSAGING_STORE: path } })
  opened.push(other)
  expect(await other.meetings.appendTranscriptsWithReceipt(input)).toMatchObject({
    created: false,
    insertedTranscripts: 0,
    replayedTranscripts: 1,
    supersededTranscripts: 0,
  })
  expect(
    await other.meetings.appendTranscriptsWithReceipt({
      ...input,
      now: 2000,
      transcripts: [{ ...transcript, contentHash: "corrected-BobSample" }],
    }),
  ).toMatchObject({ created: false, insertedTranscripts: 1, replayedTranscripts: 0, supersededTranscripts: 1 })
  expect(await store.meetings.appendTranscriptsWithReceipt(input)).toMatchObject({
    created: false,
    insertedTranscripts: 0,
    replayedTranscripts: 1,
    supersededTranscripts: 0,
  })
  expect((await store.meetings.appendTranscripts(input)).transcripts).toHaveLength(2)
})
it("returns standard typed receipt errors without changing legacy append error identity", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-append-errors-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path } })
  opened.push(store)
  const accountId = await store.accounts.saveAccount(
    { provider: "example", account: "AliceExample" },
    { name: "Alice Example" },
  )
  const original = sampleMeeting().transcripts[0]
  const transcripts = [
    {
      ...original,
      contentHash: "AliceExample",
      rows: original.rows.map(({ speakerParticipantPosition: _position, ...row }) => row),
    },
  ]
  await expect(
    store.meetings.appendTranscriptsWithReceipt({ accountId, externalId: "missing", now: 1000, transcripts }),
  ).rejects.toBeInstanceOf(CliError)
  await expect(
    store.meetings.appendTranscriptsWithReceipt({ accountId: 0, externalId: "missing", now: 1000, transcripts }),
  ).rejects.toMatchObject({ code: "validation_error" })
  try {
    await store.meetings.appendTranscripts({ accountId, externalId: "missing", now: 1000, transcripts })
  } catch (error) {
    expect(error).toBeInstanceOf(MeetingError)
    expect(error).toBeInstanceOf(CliError)
  }
})

it("stores a two-speaker OpenAI transcript whose speakers overlap", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-dialogue-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path } })
  opened.push(store)
  const accountId = await store.accounts.saveAccount({ provider: "example", account: "AliceExample" }, { name: "A" })
  const target = { accountId, externalId: "call-1", now: 1000 }
  await store.meetings.appendTranscriptsWithReceipt({
    ...target,
    create: { title: "Call", startedAt: 1000, timezone: null },
    transcripts: sampleMeeting().transcripts.map(({ rows, ...transcript }) => ({
      ...transcript,
      contentHash: "sample-call",
      rows: rows.map(({ speakerParticipantPosition: _position, ...row }) => row),
    })),
  })
  const source = {
    describe: async () => ({
      id: "call.mp3",
      contentHash: "b".repeat(64),
      size: 100,
      durationMs: 10_000,
      format: "mp3",
      sampleRate: 8000,
      channels: 2,
      recognition: { engine: "openai", model: "gpt-transcribe" },
    }),
    segments: async function* () {
      yield { startMs: 0, endMs: 3000, text: "Hello", speaker: "manager" }
      yield { startMs: 2000, endMs: 4000, text: "Hi", speaker: "client" }
    },
  }

  const receipt = await transcribeMeeting(source, store.meetings, target, { apply: true })

  const meeting = await store.meetings.meeting(receipt.append?.meeting?.meeting.id ?? 0)
  const transcript = meeting?.transcripts.find(({ transcript }) => transcript.source === "openai/gpt-transcribe")
  expect(transcript?.transcript.format).toBe("openai-transcription")
  expect(transcript?.rows.map(({ speakerName, startMs }) => [speakerName, startMs])).toEqual([
    ["manager", 0],
    ["client", 2000],
  ])
})
