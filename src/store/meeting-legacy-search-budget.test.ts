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
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-legacy-search-budget-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path } })
  opened.push(store)
  const accountId = await store.accounts.saveAccount(
    { provider: "example", account: "AliceExample" },
    { name: "Alice Example" },
  )
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  const saved = await store.meetings.saveMeeting(input)
  const db = await openCache(path)
  opened.push(db)
  return { store, db, accountId, saved }
}
it("rejects more than 10000 hits from one meeting before hydrating result text", async () => {
  const { store, db, accountId, saved } = await fixture()
  const transcriptId = saved.transcripts[0]?.transcript.id
  if (!transcriptId) throw new Error("missing synthetic transcript")
  db.prepare(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<10001)
    INSERT INTO meeting_transcript_rows(meeting_transcript_id,position,start_ms,end_ms,text,created_at)
    SELECT ?,n,0,1000,'Alice Example needle',1000 FROM seq`).run(transcriptId)
  let remaining: number
  do {
    remaining = (await store.meetings.indexSearch({ accountId, limit: 1000 })).remaining
  } while (remaining)
  await expect(store.meetings.search("needle", { accountId, limit: 1 })).rejects.toMatchObject({
    code: "validation_error",
  })
  const bounded = await store.meetings.searchHits("needle", { accountId, limit: 3 })
  expect(bounded.items).toHaveLength(3)
  expect(bounded.hasMore).toBe(true)
})
it("refuses aggregate legacy result text above 64MiB without fetching its bodies", async () => {
  const { store, db, accountId, saved } = await fixture()
  const first = saved.transcripts[0]?.rows[0]
  const transcriptId = saved.transcripts[0]?.transcript.id
  if (!first || !transcriptId) throw new Error("missing synthetic cue")
  db.prepare(
    "INSERT INTO meeting_transcript_rows(meeting_transcript_id,position,start_ms,end_ms,text,created_at) VALUES(?,1,0,1000,'needle',1000)",
  ).run(transcriptId)
  const ids = db
    .prepare("SELECT id FROM meeting_transcript_rows WHERE meeting_transcript_id=? ORDER BY id")
    .all(transcriptId)
    .map((row) => Number(row.id))
  for (const id of ids) {
    db.prepare("UPDATE meeting_transcript_rows SET text='needle '||CAST(zeroblob(?) AS TEXT) WHERE id=?").run(
      34 * 1024 ** 2,
      id,
    )
    db.prepare(
      "INSERT INTO meeting_words(rowid,normalized_text,scope) VALUES(?,'needle','meeting_transcript_row')",
    ).run(id * 4 + 1)
    db.prepare("DELETE FROM meeting_index_pending WHERE indexable_type='meeting_transcript_row' AND id=?").run(id)
  }
  await expect(store.meetings.search("needle", { accountId })).rejects.toMatchObject({ code: "validation_error" })
})
it("refuses a queued cue above 64MiB before legacy index hydration and retains its queue", async () => {
  const { store, db, accountId, saved } = await fixture()
  const rowId = saved.transcripts[0]?.rows[0]?.id
  if (!rowId) throw new Error("missing synthetic cue")
  db.prepare("UPDATE meeting_transcript_rows SET text=CAST(zeroblob(?) AS TEXT) WHERE id=?").run(
    64 * 1024 ** 2 + 1,
    rowId,
  )
  await expect(store.meetings.search("example", { accountId })).rejects.toMatchObject({ code: "validation_error" })
  expect(
    db.prepare("SELECT 1 FROM meeting_index_pending WHERE indexable_type='meeting_transcript_row' AND id=?").get(rowId),
  ).toBeDefined()
})
