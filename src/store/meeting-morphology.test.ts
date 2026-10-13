import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { sampleMeeting } from "../meetings/testing/index.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close()
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-morphology-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path }, now: () => 1000 })
  opened.push(store)
  const accountId = await store.saveAccount({ provider: "example", account: "AliceExample" }, { name: "Alice Example" })
  const otherId = await store.saveAccount({ provider: "example", account: "BobSample" }, { name: "Bob Sample" })
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  const original = input.transcripts[0].rows[0]
  const texts = [
    "Alice Example runs with projects",
    "Bob Sample organizó reuniones",
    "Alice Example обсуждала договоры",
    "Bob Sample runs and organizó",
    `Alice Example needle ${"x".repeat(50000)}`,
  ]
  input.transcripts[0].rows.splice(
    0,
    input.transcripts[0].rows.length,
    ...texts.map((text, i) => ({ ...original, position: i, text, speakerParticipantPosition: null })),
  )
  const saved = await store.meetings.saveMeeting(input)
  await store.meetings.saveMeeting({ ...input, meeting: { ...input.meeting, accountId: otherId } })
  const db = await openCache(path)
  opened.push(db)
  return { store, db, accountId, otherId, saved, input }
}
const fill = async (store: Awaited<ReturnType<typeof openStore>>, accountId: number) => {
  let result: { indexed: number; remaining: number }
  do {
    result = await store.meetings.indexSearch({ accountId, limit: 2 })
  } while (result.remaining)
}
it("matches configured English, Spanish and Russian word forms with ALL-term semantics and scoped hits", async () => {
  const { store, accountId, otherId, saved } = await fixture()
  await fill(store, accountId)
  expect((await store.meetings.searchHits("running", { accountId })).items).toHaveLength(2)
  expect((await store.meetings.searchHits("organizar", { accountId })).items).toHaveLength(2)
  expect((await store.meetings.searchHits("обсуждать договор", { accountId })).items).toHaveLength(1)
  const mixed = await store.meetings.searchHits("running organizar", { accountId })
  expect(mixed.items).toHaveLength(1)
  expect(mixed.items[0]?.text).toBe("Bob Sample runs and organizó")
  expect(mixed.items[0]?.meetingId).toBe(saved.meeting.id)
  expect((await store.meetings.searchHits("running unrelated", { accountId })).items).toEqual([])
  expect((await store.meetings.searchHits("running", { accountId: otherId })).items).toEqual([])
  expect((await store.meetings.searchHits("running", { accountId: otherId })).coverage.indexing).toBe("pending")
})
it("rebuilds existing literal-only indexes in bounded batches without skipping low IDs for a queued high ID", async () => {
  const { store, db, accountId, saved } = await fixture()
  await store.meetings.search("example", { accountId })
  const last = saved.transcripts[0]?.rows.at(-1)?.id
  if (!last) throw new Error("missing synthetic last row")
  db.prepare("INSERT OR IGNORE INTO meeting_index_pending(indexable_type,id) VALUES('meeting_transcript_row',?)").run(
    last,
  )
  const first = await store.meetings.indexSearch({ accountId, limit: 1 })
  expect(first.indexed).toBe(1)
  expect(first.remaining).toBeGreaterThan(0)
  const state = db.prepare("SELECT * FROM search_index_state WHERE name=?").get(`meeting_stems:${accountId}`)
  expect(Number(state?.filled_through)).toBeLessThan(last * 4 + 1)
  expect((await store.meetings.searchHits("running", { accountId })).items).toHaveLength(1)
  expect((await store.meetings.searchHits("running", { accountId })).coverage.indexing).toBe("pending")
  await fill(store, accountId)
  expect((await store.meetings.searchHits("running", { accountId })).items).toHaveLength(2)
  expect(
    db.prepare("SELECT built_at FROM search_index_state WHERE name=?").get(`meeting_stems:${accountId}`)?.built_at,
  ).toBe(1000)
})
it("honors none/changed/unknown analyzers, normalizer provenance and cursor binding", async () => {
  const { store, db, accountId } = await fixture()
  await fill(store, accountId)
  const first = await store.meetings.searchHits("example", { accountId, limit: 1 })
  if (!first.nextCursor) throw new Error("missing synthetic cursor")
  await store.saveStemmers({ cyrillic: "none", latin: "none" })
  await expect(store.meetings.searchHits("example", { accountId, after: first.nextCursor })).rejects.toMatchObject({
    code: "validation_error",
  })
  expect((await store.meetings.searchHits("running", { accountId })).items).toEqual([])
  expect((await store.meetings.searchHits("running", { accountId })).coverage.indexing).toBe("pending")
  await fill(store, accountId)
  expect((await store.meetings.searchHits("running", { accountId })).items).toEqual([])
  await store.saveStemmers({ cyrillic: "russian", latin: "english,spanish" })
  await fill(store, accountId)
  db.prepare("UPDATE search_index_state SET normalizer_version=0 WHERE name=?").run(`meeting_stems:${accountId}`)
  expect((await store.meetings.searchHits("running", { accountId })).items).toEqual([])
  expect((await store.meetings.searchHits("running", { accountId })).coverage.indexing).toBe("pending")
  await fill(store, accountId)
  expect((await store.meetings.searchHits("running", { accountId })).items).toHaveLength(2)
  db.prepare("UPDATE store_settings SET value=? WHERE key='searchStemmers'").run('{"latin":"unknown-example"}')
  expect((await store.meetings.searchHits("example", { accountId })).items.length).toBeGreaterThan(0)
  const added = await store.meetings.saveMeeting({
    ...sampleMeeting(),
    meeting: { ...sampleMeeting().meeting, accountId, externalId: "unknown-stemmer-occurrence", startedAt: 5000 },
  })
  expect((await store.meetings.indexSearch({ accountId })).remaining).toBe(0)
  const wordsOnly = await store.meetings.searchHits("example", { accountId, meetingId: added.meeting.id })
  expect(wordsOnly.items.length).toBeGreaterThan(0)
  expect(wordsOnly.coverage.indexing).toBe("pending")
})
it("filters old-producer stale stem matches against current text while advancing scanned candidates", async () => {
  const { store, db, accountId, saved } = await fixture()
  await fill(store, accountId)
  const row = saved.transcripts[0]?.rows[0]
  if (!row) throw new Error("missing synthetic row")
  db.prepare("UPDATE meeting_transcript_rows SET text=? WHERE id=?").run("Bob Sample unrelated correction", row.id)
  db.prepare("DELETE FROM meeting_words WHERE rowid=?").run(row.id * 4 + 1)
  db.prepare("INSERT INTO meeting_words(rowid,normalized_text,scope) VALUES(?,?,'meeting_transcript_row')").run(
    row.id * 4 + 1,
    "bob sample unrelated correction",
  )
  db.prepare("DELETE FROM meeting_index_pending WHERE indexable_type='meeting_transcript_row' AND id=?").run(row.id)
  const first = await store.meetings.searchHits("running", { accountId, limit: 1 })
  expect(first.items).toEqual([])
  expect(first.hasMore).toBe(true)
  expect(first.coverage.indexing).toBe("pending")
  if (!first.nextCursor) throw new Error("missing synthetic continuation")
  const next = await store.meetings.searchHits("running", { accountId, limit: 1, after: first.nextCursor })
  expect(next.items).toHaveLength(1)
  expect(next.items[0]?.text).toBe("Bob Sample runs and organizó")
})
it("invalidates stem provenance when legacy word maintenance consumes corrections", async () => {
  const { store, db, accountId, saved } = await fixture()
  await fill(store, accountId)
  const row = saved.transcripts[0]?.rows[0]
  if (!row) throw new Error("missing synthetic row")
  db.prepare("UPDATE meeting_transcript_rows SET text=? WHERE id=?").run("Alice Example unrelated edit", row.id)
  await store.meetings.search("example", { accountId })
  expect((await store.meetings.searchHits("running", { accountId })).items).toEqual([])
  expect((await store.meetings.searchHits("running", { accountId })).coverage.indexing).toBe("pending")
  await fill(store, accountId)
  expect((await store.meetings.searchHits("running", { accountId })).items).toHaveLength(1)
})
it("keeps very long identifiers literal without entering Snowball and validates query word limits", async () => {
  const { store, accountId } = await fixture()
  await fill(store, accountId)
  expect((await store.meetings.searchHits("x".repeat(1100), { accountId })).items).toHaveLength(1)
  expect((await store.meetings.searchHits("needle", { accountId })).items).toHaveLength(1)
  await expect(store.meetings.searchHits(Array(129).fill("example").join(" "), { accountId })).rejects.toMatchObject({
    code: "validation_error",
  })
  await expect(store.meetings.indexSearch({ accountId: 999999 })).rejects.toMatchObject({ code: "not_found" })
})
