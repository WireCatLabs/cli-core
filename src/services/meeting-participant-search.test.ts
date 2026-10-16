import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, expect, it, vi } from "vitest"
import { addMeetingCommands } from "../meetings/cli/index.js"
import { meetingPeople, validateMeetingParticipantSearch } from "../meetings/index.js"
import { callMeetingTool } from "../meetings/mcp/index.js"
import { memoryMeetingStore, sampleMeeting } from "../meetings/testing/index.js"
import { openCache } from "../store/open.js"
import { openStore } from "../store/store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close()
})
const fixture = async (provider = "example") => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-people-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path }, now: () => 3000 })
  opened.push(store)
  const accountId = await store.accounts.saveAccount({ provider, account: "example" }, { name: "Alice Example" })
  const foreign = await store.accounts.saveAccount(
    { provider: "second-example", account: "foreign" },
    { name: "Bob Sample" },
  )
  let sequence = 0
  const add = async (name: string | null, identity = `participant-${sequence}`, account = accountId) => {
    const input = sampleMeeting()
    input.meeting.accountId = account
    input.meeting.externalId = `example-${sequence++}`
    input.participants[0].displayName = name
    input.participants[0].email = null
    input.participants[0].identity = { provider, externalId: identity, name, metadata: null }
    input.participants[0].metadata = { unrelated: "x".repeat(2 * 1024 ** 2) }
    return store.meetings.saveMeeting(input)
  }
  return { store, accountId, foreign, add, path }
}

it("pages observations by account and query, preserving duplicate-name ambiguity and a bounded snapshot", async () => {
  const f = await fixture()
  await f.add("Alice Example", "alice-a")
  await f.add("Alice Example", "alice-b")
  await f.add("Alice Example", "foreign-alice", f.foreign)
  const first = await f.store.meetings.participantCandidates("ALICE", { accountId: f.accountId, limit: 1 })
  expect(first).toMatchObject({
    has_more: true,
    ambiguity: { scope: "page", multiple_identities: false },
    coverage: { scanned: 1, read_bytes: 13, truncated_by: "limit", archive_completeness: "unknown" },
  })
  expect(first.items).toHaveLength(1)
  expect(first.items[0]).not.toHaveProperty("metadata")
  await f.add("Alice Example", "new-alice")
  const second = await f.store.meetings.participantCandidates("alice", {
    accountId: f.accountId,
    cursor: first.next_cursor ?? undefined,
    limit: 1,
  })
  expect(second).toMatchObject({ has_more: false, next_cursor: null })
  expect(second.items[0]?.identity_id).not.toBe(first.items[0]?.identity_id)
  const fresh = await f.store.meetings.participantCandidates("alice", { accountId: f.accountId })
  expect(fresh.items).toHaveLength(3)
  expect(fresh.ambiguity).toMatchObject({ scope: "page", multiple_identities: true })
  await expect(
    f.store.meetings.participantCandidates("bob", {
      accountId: f.accountId,
      cursor: first.next_cursor ?? undefined,
    }),
  ).rejects.toMatchObject({ code: "validation_error" })
  await expect(
    f.store.meetings.participantCandidates("alice", {
      accountId: f.foreign,
      cursor: first.next_cursor ?? undefined,
    }),
  ).rejects.toMatchObject({ code: "validation_error" })
})

it("matches Unicode names literally and reports continuation even when a scan page has no matches", async () => {
  const f = await fixture("second-provider")
  await f.add("Bob Sample")
  await f.add("Алиса Пример", "alice-cyrillic")
  await f.add("АЛИСА ПРИМЕР", "alice-cyrillic")
  await f.add("Ａｌｉｃｅ Example")
  const empty = await f.store.meetings.participantCandidates("алиса", { accountId: f.accountId, scanLimit: 1 })
  expect(empty).toMatchObject({ items: [], has_more: true, coverage: { scanned: 1, truncated_by: "scan_limit" } })
  const matches = await f.store.meetings.participantCandidates("АлИсА", {
    accountId: f.accountId,
    cursor: empty.next_cursor ?? undefined,
  })
  expect(matches.items).toHaveLength(2)
  expect(matches.ambiguity).toMatchObject({ multiple_identities: false })
  expect(matches.ambiguity.identity_ids).toHaveLength(1)
  const width = await f.store.meetings.participantCandidates("alice", { accountId: f.accountId })
  expect(width.items[0]?.display_name).toBe("Ａｌｉｃｅ Example")
  expect((await f.store.meetings.participantCandidates("%_", { accountId: f.accountId })).items).toEqual([])
  const raw = await openCache(f.path)
  opened.push(raw)
  raw
    .prepare("UPDATE meeting_participants SET display_name = NULL, email = ? WHERE id = ?")
    .run("alice@example.com", width.items[0]?.participant_id ?? 0)
  expect(
    (await f.store.meetings.participantCandidates("ALICE@EXAMPLE.COM", { accountId: f.accountId })).items,
  ).toMatchObject([{ display_name: null, email: "alice@example.com" }])
})

it("preflights UTF-8 name bytes without reading metadata or oversized out-of-window text", async () => {
  const f = await fixture()
  await f.add("Alice Example")
  await f.add("Bob Sample")
  const raw = await openCache(f.path)
  opened.push(raw)
  raw
    .prepare("UPDATE meeting_participants SET display_name = ? WHERE id = (SELECT max(id) FROM meeting_participants)")
    .run("Я".repeat(1024 ** 2))
  const page = await f.store.meetings.participantCandidates("example", { accountId: f.accountId, maxReadBytes: 13 })
  expect(page).toMatchObject({ has_more: true, coverage: { read_bytes: 13, truncated_by: "read_bytes" } })
  const limited = await f.store.meetings.participantCandidates("example", {
    accountId: f.accountId,
    limit: 1,
    maxReadBytes: 13,
  })
  expect(limited.coverage.truncated_by).toBe("limit")
  await expect(
    f.store.meetings.participantCandidates("example", {
      accountId: f.accountId,
      cursor: page.next_cursor ?? undefined,
    }),
  ).rejects.toThrow("before text read")
  await expect(
    f.store.meetings.participantCandidates("example", {
      accountId: f.accountId,
      maxReadBytes: 12,
    }),
  ).rejects.toMatchObject({ code: "validation_error" })
  raw
    .prepare(
      "UPDATE meetings SET deleted_at = 4000 WHERE id = (SELECT meeting_id FROM meeting_participants ORDER BY id DESC LIMIT 1)",
    )
    .run()
  expect(
    await f.store.meetings.participantCandidates("example", {
      accountId: f.accountId,
      cursor: page.next_cursor ?? undefined,
    }),
  ).toMatchObject({ items: [], has_more: false, coverage: { scanned: 0, read_bytes: 0 } })
})

it("exposes equivalent bounded CLI and MCP reads while retaining older adapter compatibility", async () => {
  const f = await fixture()
  await f.add("Alice Example")
  await f.add("Alice Example")
  const output = vi.fn()
  const program = new Command("example")
  addMeetingCommands(program, { store: f.store.meetings, accountId: f.accountId, write: output })
  await program.parseAsync(
    ["meetings", "people", "Alice", "--limit", "1", "--scan-limit", "2", "--max-read-bytes", "100", "--json"],
    { from: "user" },
  )
  const page = output.mock.calls[0]?.[0]
  expect(page).toMatchObject({
    kind: "meeting_participants",
    page: { mode: "cursor", limit: 1, has_more: true, next_cursor: expect.any(String) },
    next: [
      {
        step: "page.next",
        command: "meetings people",
        args: { query: "Alice", limit: 1, scan_limit: 2, max_read_bytes: 100, cursor: expect.any(String) },
      },
    ],
  })
  expect(page).not.toHaveProperty("next_cursor")
  expect(page).not.toHaveProperty("has_more")
  const mcp = await callMeetingTool(f.store.meetings, "meeting_people", {
    query: "Alice",
    account_id: f.accountId,
    limit: 1,
    scan_limit: 2,
    max_read_bytes: 100,
  })
  expect(mcp).toMatchObject({ structuredContent: page })
  const legacyRead = vi.spyOn(f.store.meetings, "participants")
  expect(await callMeetingTool(f.store.meetings, "meeting_people", { query: "Alice" })).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "configuration_error" } },
  })
  expect(legacyRead).not.toHaveBeenCalled()
  expect(
    await callMeetingTool(f.store.meetings, "meeting_people", {
      query: "Alice",
      account_id: f.accountId,
      cursor: "bad-cursor",
    }),
  ).toMatchObject({ isError: true })
  const legacy = memoryMeetingStore()
  await legacy.saveMeeting(sampleMeeting())
  expect(await meetingPeople(legacy, "Alice", 1)).toMatchObject({ hasMore: false })
  await expect(meetingPeople(legacy, "Alice", 1, { limit: 1 })).rejects.toMatchObject({ code: "configuration_error" })
})

it("rejects invalid bounds, malformed cursors and cancellation before selecting names", async () => {
  const f = await fixture()
  for (const options of [{ limit: 0 }, { limit: 1001 }, { scanLimit: 10001 }, { maxReadBytes: 0 }, { accountId: 0 }])
    expect(() => validateMeetingParticipantSearch("Alice", { accountId: f.accountId, ...options })).toThrow()
  for (const query of ["", " ", "x\0y", "x".repeat(501)])
    expect(() => validateMeetingParticipantSearch(query, { accountId: f.accountId })).toThrow()
  for (const cursor of ["!", Buffer.from("null").toString("base64url"), Buffer.from("{}").toString("base64url")])
    await expect(
      f.store.meetings.participantCandidates("Alice", { accountId: f.accountId, cursor }),
    ).rejects.toMatchObject({ code: "validation_error" })
  const abort = new AbortController()
  abort.abort(new Error("example cancellation"))
  await expect(
    f.store.meetings.participantCandidates("Alice", { accountId: f.accountId, signal: abort.signal }),
  ).rejects.toThrow("example cancellation")
})
