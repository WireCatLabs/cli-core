import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { sampleMeeting } from "../meetings/testing/index.js"
import { migrate } from "./migrations.js"
import { meetingStoreOver } from "./sqlite/meetings.js"
import { openSqlite } from "./sqlite/open.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close()
})

const russian = "Давайте обсудим план на следующую неделю и сроки по проекту."

const seeded = async () => {
  const { database, orm } = await openSqlite(join(mkdtempSync(join(tmpdir(), "meeting-languages-")), "store.db"))
  opened.push(database)
  migrate(database)
  database
    .prepare(
      "INSERT INTO accounts (id, provider, external_id, name, created_at, updated_at) VALUES (1, 'example', 'first', 'First Example', 1, 1)",
    )
    .run()
  const store = meetingStoreOver({ database, orm, now: () => 3000 })
  const input = sampleMeeting()
  const transcript = input.transcripts[0] as (typeof input.transcripts)[0]
  transcript.language = null
  const [first] = transcript.rows
  if (!first) throw new Error("missing invented row")
  transcript.rows = [first, { ...first }, { ...first }]
  transcript.rows.forEach((row, position) => {
    Object.assign(row, { position, startMs: position * 1000, endMs: position * 1000 + 900 })
    row.text = position === 2 ? "Let me share my screen, okay?" : russian
  })
  await store.saveMeeting(input)
  return { database, store }
}

describe("transcript languages in the SQLite meeting store", () => {
  it("previews the language of transcripts that have none, and stores it only when applied", async () => {
    const { database, store } = await seeded()
    const stored = () => database.prepare("SELECT language FROM meeting_transcripts").all()

    expect(await store.fillTranscriptLanguages({ accountId: 1, apply: false, now: 5000 })).toEqual({
      accountId: 1,
      applied: false,
      transcripts: 1,
      languages: [{ language: "ru", transcripts: 1 }],
    })
    expect(stored()).toEqual([{ language: null }])

    await store.fillTranscriptLanguages({ accountId: 1, apply: true, now: 5000 })
    expect(stored()).toEqual([{ language: "ru" }])
    expect((await store.fillTranscriptLanguages({ accountId: 1, apply: true, now: 6000 })).transcripts).toBe(0)
  })

  it("gives a transcript hit its language and its line out of the transcript's lines", async () => {
    const { store } = await seeded()
    await store.fillTranscriptLanguages({ accountId: 1, apply: true, now: 5000 })

    const {
      items: [legacy],
    } = await store.search("screen")
    expect(legacy).toMatchObject({ scope: "transcript", language: "ru", line: 3, linesTotal: 3 })
    const { items } = await store.searchHits("screen", { accountId: 1 })
    expect(items[0]).toMatchObject({ scope: "transcript", language: "ru", line: 3, linesTotal: 3 })
  })
})
