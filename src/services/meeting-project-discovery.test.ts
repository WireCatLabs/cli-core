import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, expect, it, vi } from "vitest"
import { addMeetingProjectEvidenceCommand } from "../meetings/cli/index.js"
import type { MeetingProjectDiscoveryReader, MeetingSave, MeetingSearchPage } from "../meetings/index.js"
import { callMeetingProjectEvidenceTool } from "../meetings/mcp/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { openStore } from "../store/store.js"
import { readMeetingProjectDiscovery } from "./meeting-project-discovery.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const fixture = async (provider = "example-calendar") => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-project-words-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path }, now: () => 3000 })
  opened.push(store)
  const accountId = await store.accounts.saveAccount({ provider, account: "AliceExample" }, { name: "Alice Example" })
  const foreign = await store.accounts.saveAccount(
    { provider: "second-example", account: "BobSample" },
    { name: "Bob Sample" },
  )
  const sample = sampleMeeting()
  sample.participants[0].identity.provider = provider
  sample.participants[0].identity.externalId = "alice-example-guest"
  const row = sample.transcripts[0].rows[0]
  const input: MeetingSave = {
    ...sample,
    meeting: { ...sample.meeting, accountId },
    chat: [],
    summaries: [],
    transcripts: [
      {
        ...sample.transcripts[0],
        rows: ["Research Example launch", "RES launch", "исследование launch", "RES review", "Study Work launch"].map(
          (text, position) => ({ ...row, position, text }),
        ),
      },
    ],
  }
  const first = await store.meetings.saveMeeting(input)
  await store.meetings.saveMeeting({
    ...input,
    meeting: { ...input.meeting, externalId: "later-example", startedAt: 2000 },
  })
  await store.meetings.saveMeeting({ ...input, meeting: { ...input.meeting, accountId: foreign } })
  await store.meetings.indexSearch({ accountId })
  await store.meetings.indexSearch({ accountId: foreign })
  const project = await store.knowledge.addProject({ name: "Research Example", key: "RES", scope: "work" })
  await store.knowledge.addVocabularyAlias({ kind: "project", id: project.id }, "исследование")
  await store.knowledge.addVocabularyAlias({ kind: "project", id: project.id }, "Study Work")
  const ports = { vocabulary: store.knowledge, search: store.meetings }
  const participant = first.participants[0]
  if (!participant) throw Error("missing invented participant")
  const options = {
    accountId,
    participantIdentityId: participant.identityId,
    since: 1000,
    until: 1000,
    limit: 1,
    maxReadBytes: 1024,
  }
  return { store, ports, options, accountId, foreign, first, project }
}

it("mounts one shared CLI/MCP evidence flow for two providers without confirming project membership", async () => {
  for (const provider of ["example-calendar", "sample-assistant"]) {
    const f = await fixture(provider)
    const read: MeetingProjectDiscoveryReader = (project, options) =>
      readMeetingProjectDiscovery(f.ports, project, { ...options, accountId: f.accountId })
    const program = new Command("example")
    program.command("meetings")
    const output = vi.fn()
    addMeetingProjectEvidenceCommand(program, { read, signal: () => undefined, output })
    await program.parseAsync(
      [
        "meetings",
        "projects",
        "evidence",
        "RES",
        `identity_id:${f.options.participantIdentityId}`,
        `meeting_id:${f.first.meeting.id}`,
        "--limit",
        "1",
        "--max-read-bytes",
        "1024",
      ],
      { from: "user" },
    )
    const first = output.mock.calls[0]?.[0]
    expect(first.item.hits[0].ref).toMatch(new RegExp(`^meeting:${f.accountId}/${f.first.meeting.id}/`))
    expect(first.item.association).toBe("unconfirmed-word-evidence")
    const result = await callMeetingProjectEvidenceTool(read, first.next[0].args)
    expect(result).not.toHaveProperty("isError")
    expect(result.structuredContent).toMatchObject({
      item: {
        term: { kind: "key" },
        selection: { identity_id: String(f.options.participantIdentityId) },
        coverage: { archive_completeness: "unknown", duplicates: "may-repeat-between-terms" },
      },
    })
    expect((await f.store.meetings.searchHits("RES", { ...f.options, projectId: Number(f.project.id) })).items).toEqual(
      [],
    )
  }
})

it("discovers unlinked meetings through canonical names, keys and aliases with bounded cited continuation", async () => {
  const f = await fixture()
  const before = await f.store.knowledge.vocabulary({ kind: "project" })
  expect((await f.store.meetings.searchHits("RES", { ...f.options, projectId: Number(f.project.id) })).items).toEqual(
    [],
  )
  const read = vi.spyOn(f.store.meetings, "searchHits")
  const pages = []
  let cursor: string | undefined
  do {
    const page = await readMeetingProjectDiscovery(f.ports, "RES", { ...f.options, cursor })
    pages.push(page)
    expect(page.hits.length).toBeLessThanOrEqual(1)
    expect(
      page.hits.every((hit) => hit.meetingId === f.first.meeting.id && hit.ref.startsWith(`meeting:${f.accountId}/`)),
    ).toBe(true)
    expect(page).toMatchObject({
      association: "unconfirmed-word-evidence",
      coverage: { archiveCompleteness: "unknown", duplicates: "may-repeat-between-terms" },
    })
    cursor = page.nextCursor ?? undefined
    if (pages.length > 10) throw Error("unbounded discovery")
  } while (cursor)
  expect(pages.map((page) => page.term.name)).toEqual([
    "Research Example",
    "RES",
    "RES",
    "RES",
    "Study Work",
    "исследование",
  ])
  expect(pages.at(-1)).toMatchObject({ hasMore: false, nextCursor: null, coverage: { remainingTerms: 0 } })
  expect(pages[0]?.hits[0]?.ref).toBe(pages[1]?.hits[0]?.ref)
  expect(read).toHaveBeenCalledTimes(pages.length)
  for (const [, options] of read.mock.calls) expect(options).toMatchObject(f.options)
  expect(await f.store.knowledge.vocabulary({ kind: "project" })).toEqual(before)
})

it("keeps empty alias pages resumable and applies the same account/date behavior for another provider", async () => {
  const f = await fixture("sample-assistant")
  const first = await readMeetingProjectDiscovery(f.ports, "RES", { ...f.options, since: 9000, until: 9001 })
  expect(first).toMatchObject({ hits: [], hasMore: true, term: { kind: "canonical" } })
  const next = await readMeetingProjectDiscovery(f.ports, "res", {
    ...f.options,
    since: 9000,
    until: 9001,
    cursor: first.nextCursor ?? undefined,
    limit: 2,
    maxReadBytes: 2048,
  })
  expect(next).toMatchObject({ hits: [], hasMore: true, term: { kind: "key" }, coverage: { termIndex: 1 } })
  const ordinary = await readMeetingProjectDiscovery(f.ports, "исследование", f.options)
  expect(ordinary.hits).toHaveLength(1)
  expect(ordinary.project.id).toBe(f.project.id)
  await f.store.knowledge.addProject({ name: "CODE", key: "CODE", scope: "work" })
  const duplicate = await readMeetingProjectDiscovery(f.ports, "CODE", { ...f.options, maxTerms: 1 })
  expect(duplicate).toMatchObject({ hits: [], hasMore: false, coverage: { termsTotal: 1 } })
})

it("rejects changed scopes, queries and vocabulary before reading another alias", async () => {
  const f = await fixture()
  const first = await readMeetingProjectDiscovery(f.ports, "RES", f.options)
  const read = vi.spyOn(f.store.meetings, "searchHits")
  for (const change of [
    { accountId: f.foreign },
    { meetingId: f.first.meeting.id + 1 },
    { participantIdentityId: 999 },
    { personId: 12 },
    { since: 0 },
    { until: 2000 },
    { tagId: 12 },
    { eventId: 12 },
    { meetingSeriesId: 12 },
  ])
    await expect(
      readMeetingProjectDiscovery(f.ports, "RES", { ...f.options, ...change, cursor: first.nextCursor ?? undefined }),
    ).rejects.toMatchObject({ code: "validation_error" })
  await expect(
    readMeetingProjectDiscovery(f.ports, "Research Example", { ...f.options, cursor: first.nextCursor ?? undefined }),
  ).rejects.toMatchObject({ code: "validation_error" })
  await f.store.knowledge.addVocabularyAlias({ kind: "project", id: f.project.id }, "Sample Research")
  await expect(
    readMeetingProjectDiscovery(f.ports, "RES", { ...f.options, cursor: first.nextCursor ?? undefined }),
  ).rejects.toMatchObject({ code: "validation_error" })
  expect(read).not.toHaveBeenCalled()
})

it("does not broaden missing/ambiguous project names, exhaust budgets or advance after a byte error", async () => {
  const f = await fixture()
  const read = vi.spyOn(f.store.meetings, "searchHits")
  await expect(readMeetingProjectDiscovery(f.ports, "Research Exampl", f.options)).rejects.toMatchObject({
    code: "not_found",
  })
  for (const change of [
    { accountId: 0 },
    { limit: 0 },
    { maxTerms: 0 },
    { maxTerms: 129 },
    { maxVocabularyReadBytes: 0 },
    { maxTerms: 1 },
    { projectId: 1 },
    { after: "abc" },
    { cursor: "!" },
    { cursor: Buffer.from("null").toString("base64url") },
    { cursor: Buffer.from("{}").toString("base64url") },
  ])
    await expect(readMeetingProjectDiscovery(f.ports, "RES", { ...f.options, ...change })).rejects.toMatchObject({
      code: "validation_error",
    })
  expect(read).not.toHaveBeenCalled()
  const cancelled = new AbortController()
  cancelled.abort(new Error("example cancellation"))
  await expect(readMeetingProjectDiscovery(f.ports, "RES", { ...f.options, signal: cancelled.signal })).rejects.toThrow(
    "example cancellation",
  )
  await expect(readMeetingProjectDiscovery(f.ports, "RES", { ...f.options, maxReadBytes: 1 })).rejects.toMatchObject({
    code: "validation_error",
  })
  await f.store.knowledge.addProject({ name: "Research Example", key: "RSP", scope: "personal" })
  await expect(readMeetingProjectDiscovery(f.ports, "Research Example", f.options)).rejects.toMatchObject({
    code: "validation_error",
  })
})

it("rejects uncited/foreign hits and broken continuation from a provider port", async () => {
  const f = await fixture()
  const raw = await f.store.meetings.searchHits("Research Example", f.options)
  const hit = raw.items[0]
  if (!hit) throw Error("missing invented hit")
  for (const result of [
    { ...raw, items: [{ ...hit, ref: undefined }] },
    { ...raw, items: [{ ...hit, ref: `meeting:${f.foreign}/${hit.meetingId}/1/0` }] },
    { ...raw, items: [{ ...hit, ref: `meeting:${f.accountId}/${hit.meetingId}` }] },
    { ...raw, items: [hit, hit] },
    { ...raw, hasMore: true, nextCursor: null },
    { ...raw, hasMore: true, nextCursor: "!" },
    { ...raw, hasMore: true, nextCursor: undefined },
  ]) {
    const search = { searchHits: vi.fn(async () => result as MeetingSearchPage) }
    await expect(readMeetingProjectDiscovery({ ...f.ports, search }, "RES", f.options)).rejects.toMatchObject({
      code: "invalid_response",
    })
    expect(search.searchHits).toHaveBeenCalledOnce()
  }
  const resolve = vi.fn(f.store.knowledge.resolveVocabulary.bind(f.store.knowledge))
  await readMeetingProjectDiscovery({ ...f.ports, vocabulary: { resolveVocabulary: resolve } }, "RES", f.options)
  expect(resolve).toHaveBeenCalledWith(
    "RES",
    expect.objectContaining({ kind: "project", maxReadBytes: 1024 ** 2, maxEntries: 10000 }),
  )
})

it("captures the selected account and stops after cancellation during asynchronous ports", async () => {
  const f = await fixture()
  const defaultSearch = vi.fn(f.store.meetings.searchHits.bind(f.store.meetings))
  const defaults = await readMeetingProjectDiscovery({ ...f.ports, search: { searchHits: defaultSearch } }, "RES", {
    accountId: f.accountId,
  })
  expect(defaults.limits).toEqual({
    limit: 100,
    maxReadBytes: 4 * 1024 ** 2,
    maxVocabularyReadBytes: 1024 ** 2,
    maxTerms: 32,
  })
  expect(defaultSearch).toHaveBeenCalledWith(
    "Research Example",
    expect.objectContaining({ accountId: f.accountId, limit: 100, maxReadBytes: 4 * 1024 ** 2 }),
  )
  const original = { ...f.options }
  const vocabulary = {
    resolveVocabulary: vi.fn(async (...args: Parameters<typeof f.store.knowledge.resolveVocabulary>) => {
      original.accountId = f.foreign
      return f.store.knowledge.resolveVocabulary(...args)
    }),
  }
  const page = await readMeetingProjectDiscovery({ ...f.ports, vocabulary }, "RES", original)
  expect(page.accountId).toBe(f.accountId)
  expect(page.hits.every((hit) => hit.ref.startsWith(`meeting:${f.accountId}/`))).toBe(true)
  const controller = new AbortController()
  const read = vi.spyOn(f.store.meetings, "searchHits")
  const cancelledVocabulary = {
    resolveVocabulary: async (...args: Parameters<typeof f.store.knowledge.resolveVocabulary>) => {
      const found = await f.store.knowledge.resolveVocabulary(...args)
      controller.abort(new Error("cancelled while resolving names"))
      return found
    },
  }
  await expect(
    readMeetingProjectDiscovery({ ...f.ports, vocabulary: cancelledVocabulary }, "RES", {
      ...f.options,
      signal: controller.signal,
    }),
  ).rejects.toThrow("cancelled while resolving names")
  expect(read).not.toHaveBeenCalled()
})
