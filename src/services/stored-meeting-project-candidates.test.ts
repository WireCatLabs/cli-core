import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { itemEnvelopeSchema } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import * as v from "valibot"
import { afterEach, expect, it, vi } from "vitest"
import { addMeetingProjectCandidatesCommand } from "../cli/meeting-project-candidates-command.js"
import { readMeetingProjectCandidates } from "../cli/meeting-project-candidates-read.js"
import { meetingProjectCandidates } from "../entities/index.js"
import { callMeetingProjectCandidatesTool } from "../mcp/meeting-project-candidates.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { openStore } from "../store/store.js"
import { createStoredMeetingProjectCandidateReader } from "./stored-meeting-project-candidates.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const fixture = async (provider = "example-calendar") => {
  const path = join(mkdtempSync(join(tmpdir(), "stored-project-candidates-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path }, now: () => 3000 })
  opened.push(store)
  const scope = { provider, account: "AliceExample" }
  const accountId = await store.accounts.saveAccount(scope, { name: "Alice Example" })
  const foreign = await store.accounts.saveAccount({ provider, account: "BobExample" }, { name: "Bob Example" })
  const sample = sampleMeeting()
  sample.meeting.accountId = accountId
  sample.meeting.title = "Harbour Example planning"
  sample.participants[0].identity.provider = provider
  const rows = ["Гавань agreed a checklist", "HAR agreed a review", "Гавань approved the revision"].map(
    (text, position) => ({ ...sample.transcripts[0].rows[0], text, position }),
  )
  const saved = await store.meetings.saveMeeting({ ...sample, transcripts: [{ ...sample.transcripts[0], rows }] })
  const project = await store.knowledge.addProject({ name: "Harbour Example", key: "HAR", scope: "work" })
  await store.knowledge.addVocabularyAlias({ kind: "project", id: project.id }, "Гавань")
  const reference = `meeting:${accountId}/${saved.meeting.id}`
  const ports = { meetings: store.meetings, vocabulary: store.knowledge }
  return {
    path,
    store,
    scope,
    accountId,
    foreign,
    saved,
    reference,
    ports,
    read: createStoredMeetingProjectCandidateReader(scope, accountId, ports),
  }
}

it.each(["example-calendar", "example-conference"])(
  "hydrates bounded evidence for %s without writes",
  async (provider) => {
    const f = await fixture(provider)
    const before = readFileSync(f.path)
    const result = await f.read(f.reference)
    expect(result.source).toEqual({ ...f.scope, accountId: f.accountId, reference: f.reference })
    expect(result.items[0]?.matches.map((match) => match.source.kind)).toEqual([
      "metadata-title",
      "transcript",
      "transcript",
      "transcript",
    ])
    expect(result.items[0]?.matches[1]?.source).toMatchObject({
      reference: `${f.reference}/${f.saved.transcripts[0]?.transcript.id}/1`,
      revision: "current",
    })
    expect(result.evidence).toMatchObject({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      limits: { cues: 20, bytes: 32768, maxReadBytes: 65536, maxTranscriptPages: 1 },
      coverage: { included: 3, hasMore: false, archiveCompleteness: "unknown" },
      consistency: "live-reads",
      maxStoreCalls: 8,
    })
    expect(result.association).toBe("unconfirmed-literal-evidence")
    expect(readFileSync(f.path).equals(before)).toBe(true)
  },
)

it("resumes bounded cue pages without widening the selected meeting", async () => {
  const f = await fixture()
  const first = await f.read(f.reference, { cues: 1 })
  expect(first.evidence.coverage).toMatchObject({ included: 1, hasMore: true, truncatedBy: "cues" })
  const after = first.evidence.coverage.nextReference
  if (!after) throw Error("missing invented continuation")
  const second = await f.read(f.reference, { cues: 1, after })
  expect(second.items[0]?.matches.some((match) => match.source.reference === after)).toBe(false)
  expect(second.evidence.fingerprint).not.toBe(first.evidence.fingerprint)
  const metadata = vi.spyOn(f.store.meetings, "meetingMetadata")
  const vocabulary = vi.spyOn(f.store.knowledge, "vocabulary")
  for (const change of [
    { after: `meeting:${f.foreign}/1/1/0` },
    { after: `${f.reference}/1` },
    { after, afterTranscriptId: 1 },
    { cues: 101 },
    { bytes: 1 },
    { maxReadBytes: 65537 },
    { unknown: true },
    { afterTranscriptId: 0 },
  ]) {
    await expect(f.read(f.reference, change)).rejects.toMatchObject({ code: "validation_error" })
  }
  await expect(f.read(`meeting:${f.foreign}/1`)).rejects.toMatchObject({ code: "validation_error" })
  expect(metadata).not.toHaveBeenCalled()
  expect(vocabulary).not.toHaveBeenCalled()
})

it("refuses a stale owner and cancellation before reading meeting or vocabulary", async () => {
  const f = await fixture()
  const meetingMetadata = vi.spyOn(f.store.meetings, "meetingMetadata")
  const vocabulary = vi.spyOn(f.store.knowledge, "vocabulary")
  const account = vi.spyOn(f.store.meetings, "account")
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(f.read(f.reference, { signal: cancelled.signal })).rejects.toMatchObject({ code: "cancelled" })
  const read = createStoredMeetingProjectCandidateReader(
    { ...f.scope, account: "ChangedExample" },
    f.accountId,
    f.ports,
  )
  await expect(read(f.reference)).rejects.toMatchObject({ code: "not_found" })
  expect(account).toHaveBeenCalledOnce()
  expect(meetingMetadata).not.toHaveBeenCalled()
  expect(vocabulary).not.toHaveBeenCalled()
})

it("keeps metadata-only matches and reports unavailable transcript coverage", async () => {
  const f = await fixture()
  const read = createStoredMeetingProjectCandidateReader(f.scope, f.accountId, {
    ...f.ports,
    meetings: { ...f.store.meetings, transcripts: async () => ({ items: [], hasMore: false }) },
  })
  const result = await read(f.reference)
  expect(result.items[0]?.matches).toHaveLength(1)
  expect(result.evidence.coverage).toMatchObject({ included: 0, archiveCompleteness: "unknown" })
})

it("bounds a custom reader that keeps returning partial row pages", async () => {
  const f = await fixture()
  const page = await f.store.meetings.transcriptRows({
    accountId: f.accountId,
    meetingId: f.saved.meeting.id,
    transcriptId: f.saved.transcripts[0]?.transcript.id ?? 0,
    limit: 1,
  })
  const row = page.rows[0]
  if (!row) throw Error("missing invented row")
  const transcriptRows = vi.fn(async (input: { afterPosition?: number }) => ({
    ...page,
    rows: [{ ...row, position: (input.afterPosition ?? -1) + 1 }],
    hasMore: true,
    nextPosition: (input.afterPosition ?? -1) + 1,
  }))
  const vocabulary = vi.spyOn(f.store.knowledge, "vocabulary")
  const read = createStoredMeetingProjectCandidateReader(f.scope, f.accountId, {
    ...f.ports,
    meetings: { ...f.store.meetings, transcriptRows },
  })
  await expect(read(f.reference)).rejects.toMatchObject({
    code: "validation_error",
    message: expect.stringContaining("budget"),
  })
  expect(transcriptRows).toHaveBeenCalledTimes(5)
  expect(vocabulary).not.toHaveBeenCalled()
})

it("captures the request and owner before asynchronous reads and bounds the complete packet", async () => {
  const f = await fixture()
  const options = { cues: 2, bytes: 2048 }
  const read = createStoredMeetingProjectCandidateReader(f.scope, f.accountId, {
    ...f.ports,
    meetings: {
      ...f.store.meetings,
      account: async (id) => {
        options.cues = 100
        options.bytes = 65536
        f.scope.account = "ChangedExample"
        return f.store.meetings.account(id)
      },
    },
  })
  const result = await read(f.reference, options)
  expect(result.source.account).toBe("AliceExample")
  expect(result.evidence.limits.cues).toBe(2)
  expect(result.limits.bytes).toBe(2048)
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048)
  expect(result.evidence.coverage.hasMore).toBe(true)
  expect(result.coverage.association).toBe("unconfirmed-literal-evidence")
})

it("preserves cancellation during hydration and refuses missing capabilities", async () => {
  const f = await fixture()
  const controller = new AbortController()
  const vocabulary = vi.spyOn(f.store.knowledge, "vocabulary")
  const read = createStoredMeetingProjectCandidateReader(f.scope, f.accountId, {
    ...f.ports,
    meetings: {
      ...f.store.meetings,
      meetingMetadata: async (input) => {
        const result = await f.store.meetings.meetingMetadata(input)
        controller.abort()
        return result
      },
    },
  })
  await expect(read(f.reference, { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" })
  expect(vocabulary).not.toHaveBeenCalled()
  expect(() =>
    createStoredMeetingProjectCandidateReader(f.scope, f.accountId, {
      ...f.ports,
      meetings: { ...f.store.meetings, transcriptRows: undefined as never },
    }),
  ).toThrow("bounded meeting reads")
})

it("CLI and raw MCP return the same snake_case candidate item with schema-valid execution metadata", async () => {
  const f = await fixture()
  const program = new Command("example").exitOverride()
  program.command("meetings")
  const output = vi.fn()
  addMeetingProjectCandidatesCommand(program, { read: f.read, output, signal: () => undefined })
  await program.parseAsync(["meetings", "projects", "scan", f.reference, "--cues", "1"], { from: "user" })
  const response = await callMeetingProjectCandidatesTool(f.read, { ref: f.reference, cues: 1 })
  expect(response).not.toHaveProperty("isError")
  const cli = v.parse(itemEnvelopeSchema(meetingProjectCandidates), output.mock.calls[0]?.[0])
  const mcp = v.parse(itemEnvelopeSchema(meetingProjectCandidates), response.structuredContent)
  expect(cli.item).toEqual(mcp.item)
  expect(mcp.meta).toMatchObject({ complete: true, truncated: true })
  expect(mcp.item.source).toMatchObject({ account_id: String(f.accountId), ref: f.reference })
  expect(mcp.item.evidence.coverage.next_cursor).toMatch(/^meeting:/)
  expect(mcp.item.items[0]?.matches[1]?.source).toHaveProperty("ref")
  const continued = await readMeetingProjectCandidates(f.read, {
    ref: f.reference,
    cursor: mcp.item.evidence.coverage.next_cursor,
    cues: 1,
  })
  expect(continued.item.input_fingerprint).not.toBe(mcp.item.input_fingerprint)
})

it.each([
  [{ ref: "meeting:1/2", provider: "other" }, "provider"],
  [{ ref: "meeting:1/2", cues: 0 }, "cues"],
  [{ ref: "meeting:1/2", bytes: "2048" }, "bytes"],
  [{ ref: "meeting:1/2", cursor: "meeting:9/2/3/0" }, "cursor"],
  [{ ref: "meeting:1/2/3" }, "ref"],
] as const)("refuses malformed raw MCP arguments before calling the host: %j", async (input, field) => {
  const read = vi.fn()
  const result = await callMeetingProjectCandidatesTool(read, input)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.structuredContent)).toContain("validation_error")
  expect(JSON.stringify(result.structuredContent)).toContain(field)
  expect(read).not.toHaveBeenCalled()
})

it("maps a transcript cursor without inventing a cue and rejects a foreign host response", async () => {
  const f = await fixture()
  const packet = await f.read(f.reference)
  const read = vi.fn(async () => packet)
  await readMeetingProjectCandidates(read, { ref: f.reference, cursor: `${f.reference}/123` })
  expect(read).toHaveBeenCalledWith(f.reference, expect.objectContaining({ after: undefined, afterTranscriptId: 123 }))
  const foreign = { ...packet, source: { ...packet.source, reference: `meeting:${f.foreign}/1` } }
  await expect(readMeetingProjectCandidates(async () => foreign, { ref: f.reference })).rejects.toMatchObject({
    code: "invalid_response",
  })
  const controller = new AbortController()
  controller.abort()
  const cancelled = await callMeetingProjectCandidatesTool(read, { ref: f.reference }, controller.signal)
  expect(cancelled.isError).toBe(true)
  expect(JSON.stringify(cancelled.structuredContent)).toContain("cancelled")
})

it("rechecks the MCP item budget after hidden text expands for agent display", async () => {
  const f = await fixture()
  const packet = await f.read(f.reference, { bytes: 4096 })
  packet.source.account = "\u200b".repeat(500)
  const result = await callMeetingProjectCandidatesTool(async () => packet, { ref: f.reference, bytes: 4096 })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.structuredContent)).toContain("validation_error")
  expect(JSON.stringify(result.structuredContent)).toContain("required coverage")
})
