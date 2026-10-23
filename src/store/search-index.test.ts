import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { CacheDatabase } from "./driver.js"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { fillSearchIndex, resetSearchIndex, searchIndexState } from "./sqlite/search-index.js"
import { BACKFILL_ON_OPEN } from "./store.js"

const opened: CacheDatabase[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
})

/** A file as version 11 left it, `count` messages "w<pk> valencia", the ones in `waiting` not normalized, then migrated. */
const large = async (count = BACKFILL_ON_OPEN + 20, waiting: number[] = []): Promise<CacheDatabase> => {
  const database = await openCache(join(mkdtempSync(join(tmpdir(), "words-")), "messages.db"))
  opened.push(database)
  migrate(database, { migrations: MIGRATIONS.filter(({ version }) => version <= 11) })
  database.exec(
    `INSERT INTO accounts (id, provider, external_id, created_at,updated_at) VALUES (1, 'telegram', '100', 0,0)`,
  )
  database.exec(
    `INSERT INTO chats (id, account_id, external_id, kind, updated_at,created_at) VALUES (1, 1, '-1', 'group', 0,0)`,
  )
  const pending = `i IN (${waiting.join(", ")})`
  database.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
    INSERT INTO messages (id, chat_id, account_id, external_id, sent_at, text, normalized_text, normalizer_version,
                          created_at, source,updated_at)
    SELECT i, 1, 1, CAST(i AS TEXT), i, 'W' || i || ' Valencia 2026',
           CASE WHEN ${pending} THEN NULL ELSE 'w' || i || ' valencia 2026' END,
           CASE WHEN ${pending} THEN NULL ELSE 1 END, 0, 'history' ,0 FROM n`)
  resetSearchIndex(database)
  if (count <= BACKFILL_ON_OPEN) fillSearchIndex(database, { until: () => false })
  database.exec(
    "DELETE FROM search_terms; DELETE FROM search_term_trigrams; UPDATE search_index_state SET terms_through=0 WHERE name='message_words'",
  )
  return database
}

const found = (database: CacheDatabase, word: string) =>
  database
    .prepare("SELECT rowid FROM message_words WHERE message_words MATCH ?")
    .all(`normalized_text: ${word}`)
    .map((row) => Number(row.rowid))

describe("filling the word index", () => {
  it("**is not ready on a large file until the batches reach the watermark**, then is", async () => {
    const database = await large()
    expect(searchIndexState(database)).toMatchObject({
      watermark: BACKFILL_ON_OPEN + 20,
      filledThrough: 0,
      ready: false,
    })

    const filled = fillSearchIndex(database, { batch: 1_000, now: () => 1_000 })

    expect(filled.indexed).toBe(BACKFILL_ON_OPEN + 20)
    expect(searchIndexState(database)).toMatchObject({
      filledThrough: BACKFILL_ON_OPEN + 20,
      ready: true,
      builtAt: new Date(1_000).toISOString(),
    })
    expect(found(database, "w1")).toEqual([1])
    database.exec("INSERT INTO message_words (message_words) VALUES ('integrity-check')")
  })

  it("**stops between batches when told to, and the next run goes on** from where it stopped", async () => {
    const database = await large()
    let indexed = 0
    fillSearchIndex(database, {
      batch: 1_000,
      until: () => indexed >= 2_000,
      onBatch: (step, done) => {
        if (step === "indexed") indexed = done
      },
    })
    expect(searchIndexState(database)?.filledThrough).toBe(2_000)

    fillSearchIndex(database, { batch: 1_000 })
    expect(searchIndexState(database)?.ready).toBe(true)
  })

  it("**normalizes first**: a message waiting for its normalized text keeps the index from being ready", async () => {
    const database = await large(BACKFILL_ON_OPEN + 20, [3, BACKFILL_ON_OPEN + 10])
    expect(searchIndexState(database)?.pendingNormalization).toBe(2)

    const filled = fillSearchIndex(database)

    expect(filled.normalized).toBe(2)
    expect(found(database, "w3")).toEqual([3])
    expect(searchIndexState(database)).toMatchObject({ pendingNormalization: 0, ready: true })
  })

  it("**builds the typo vocabulary from words only**: no chat or sender token, no trigrams for a number", async () => {
    const database = await large(30)
    expect(searchIndexState(database)).toMatchObject({ ready: true, termsThrough: 0 })

    const filled = fillSearchIndex(database)

    expect(filled.terms).toBe(32)
    expect(searchIndexState(database)?.termsThrough).toBe(30)
    const terms = database
      .prepare("SELECT term FROM search_terms")
      .all()
      .map((row) => String(row.term))
    expect(terms).toContain("valencia")
    expect(terms.some((term) => /^[cs]\d+$/.test(term))).toBe(false)
    const pieces = (word: string) =>
      database.prepare("SELECT trigram FROM search_term_trigrams WHERE term = ? ORDER BY trigram").all(word).length
    expect(pieces("valencia")).toBe(9)
    expect(pieces("2026")).toBe(0)
  })

  it("**adds the words of messages stored after the vocabulary was built**", async () => {
    const database = await large(30)
    fillSearchIndex(database)
    database.exec(`INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, normalized_text, normalizer_version,
                     created_at, source,updated_at) VALUES (1, 1, '31', 31, 'Ruzafa, piso', 'ruzafa, piso', 1, 0, 'history',0)`)
    expect(searchIndexState(database)?.termsThrough).toBe(30)

    expect(fillSearchIndex(database).terms).toBe(2)
    const words = database.prepare("SELECT term FROM search_terms WHERE term IN ('ruzafa', 'piso')").all()
    expect(words).toHaveLength(2)
    expect(searchIndexState(database)?.termsThrough).toBe(31)
    expect(fillSearchIndex(database)).toEqual({ normalized: 0, indexed: 0, terms: 0 })
  })

  it("resumes the vocabulary after the last term written", async () => {
    const database = await large(30)
    let terms = 0
    fillSearchIndex(database, {
      batch: 10,
      until: () => terms >= 10,
      onBatch: (step, done) => {
        if (step === "terms") terms = done
      },
    })
    expect(searchIndexState(database)?.termsThrough).toBe(0)

    expect(fillSearchIndex(database, { batch: 10 }).terms).toBe(22)
    expect(Number(database.prepare("SELECT count(*) AS n FROM search_terms").get()?.n)).toBe(32)
  })

  it("**starts again from scratch on a reset**, for `store rebuild`", async () => {
    const database = await large(30)
    fillSearchIndex(database)

    resetSearchIndex(database)
    expect(searchIndexState(database)).toMatchObject({ watermark: 30, filledThrough: 0, termsThrough: 0, ready: false })
    expect(found(database, "w1")).toEqual([])
    expect(Number(database.prepare("SELECT count(*) AS n FROM search_terms").get()?.n)).toBe(0)

    fillSearchIndex(database)
    expect(found(database, "w1")).toEqual([1])
    expect(searchIndexState(database)?.ready).toBe(true)
  })

  it("does nothing on a file without the word index", async () => {
    const database = await openCache(":memory:")
    opened.push(database)

    expect(searchIndexState(database)).toBeUndefined()
    expect(fillSearchIndex(database)).toEqual({ normalized: 0, indexed: 0, terms: 0 })
  })
})
