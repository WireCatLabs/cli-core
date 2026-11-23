import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { TrackerRecords } from "../domain/tracker.js"
import { syncTracker } from "../tracker/sync.js"
import { exampleTrackerRows, fakeTrackerSource } from "../tracker/testing/index.js"
import type { CacheDatabase } from "./driver.js"
import { openSqlite } from "./sqlite/open.js"
import { vectorIndexCounts } from "./sqlite/vector-index.js"
import { type MessageStore, openStore } from "./store.js"

const MODEL = "local:invented:4"
const A = { provider: "fake-tracker", account: "a" }
const B = { provider: "fake-tracker", account: "b" }
const NOW = Date.UTC(2026, 10, 17)

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close()
})

const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "tracker-chunks-")), "store.db")
  const store = await openStore({ path, now: () => NOW })
  opened.push(store)
  const { database } = await openSqlite(path)
  opened.push(database)
  return { store, database }
}

const chunksOf = (database: CacheDatabase) =>
  database
    .prepare(
      "SELECT t.kind, t.external_id AS id, a.external_id AS account, k.content_hash AS hash FROM chunks k " +
        "JOIN tracker_items t ON t.id = k.chunkable_id JOIN accounts a ON a.id = k.account_id " +
        "WHERE k.chunkable_type = 'tracker_item' ORDER BY t.kind, t.external_id, a.external_id",
    )
    .all() as { kind: string; id: string; account: string; hash: string }[]

const vectors = (database: CacheDatabase) =>
  database
    .prepare("SELECT content_hash AS hash FROM embeddings")
    .all()
    .map(({ hash }) => String(hash))

const unit = (index: number) => Float32Array.from({ length: 4 }, (_, at) => (at === index ? 1 : 0))

/** Gives every chunk waiting a vector, the nth hash pointing along axis n mod 4. */
const embedAll = async (store: MessageStore) => {
  const waiting = await store.tracker.chunksToEmbed(MODEL, { limit: 100 })
  await store.vectors.saveVectors(
    MODEL,
    4,
    waiting.map(({ hash }, at) => ({ hash, vector: unit(at % 4) })),
  )
  return waiting
}

const issue = (externalId: string, title: string, description?: string): TrackerRecords["issue"] => ({
  externalId,
  key: externalId.toUpperCase(),
  title,
  ...(description === undefined ? {} : { description }),
  team: "team-1",
  labels: [],
  updatedAt: NOW,
})

describe("tracker chunks", () => {
  it("cuts chunks for issues, projects and comments only, with their text to embed", async () => {
    const { store, database } = await fixture()
    await syncTracker(fakeTrackerSource({ rows: exampleTrackerRows() }), store, A, { now: NOW })
    expect(new Set(chunksOf(database).map(({ kind }) => kind))).toEqual(new Set(["issue", "project", "comment"]))
    const texts = (await store.tracker.chunksToEmbed(MODEL, { limit: 100 })).map(({ text }) => text)
    expect(texts).toContain("Invoices fail for EUR accounts\n\nThe provider refuses the currency code")
    expect(texts.filter((text) => /^(Engineering|Bug|Triage|Ada Owner)/.test(text))).toEqual([])
    expect(await store.tracker.chunksLeft(MODEL)).toBe(texts.length)
  })

  it("replaces an edited item's chunks, dropping a vector no one holds and keeping one another account shares", async () => {
    const { store, database } = await fixture()
    await store.tracker.save(A, "issue", [issue("i1", "Shared words"), issue("i2", "Mine alone")], NOW)
    await store.tracker.save(B, "issue", [issue("i1", "Shared words")], NOW)
    await embedAll(store)
    const shared = chunksOf(database).find(({ account, id }) => account === "a" && id === "i1")?.hash
    const alone = chunksOf(database).find(({ id }) => id === "i2")?.hash

    await store.tracker.save(A, "issue", [issue("i1", "New words"), issue("i2", "Changed too")], NOW + 1)
    expect(vectors(database)).toContain(shared)
    expect(vectors(database)).not.toContain(alone)
    expect(chunksOf(database).filter(({ account }) => account === "a")).toHaveLength(2)
    expect(await store.tracker.chunksLeft(MODEL)).toBe(2)

    const before = chunksOf(database)
    await store.tracker.save(A, "issue", [issue("i1", "New words")], NOW + 2)
    expect(chunksOf(database)).toEqual(before)
  })

  it("drops the chunks and the index rows of an unlisted item, changes nothing on a dry run, and revives one", async () => {
    const { store, database } = await fixture()
    await store.tracker.save(A, "issue", [issue("i1", "Kept"), issue("i2", "Going")], NOW)
    await embedAll(store)

    expect(await store.tracker.removeUnlisted(A, "issue", ["i1"], NOW + 1, NOW + 1, { dryRun: true })).toBe(1)
    expect(chunksOf(database).map(({ id }) => id)).toEqual(["i1", "i2"])

    expect(await store.tracker.removeUnlisted(A, "issue", ["i1"], NOW + 1, NOW + 1)).toBe(1)
    expect(chunksOf(database).map(({ id }) => id)).toEqual(["i1"])
    expect(vectors(database)).toHaveLength(1)
    expect(vectorIndexCounts(database)).toEqual([expect.objectContaining({ indexed: 1, missing: 0, extra: 0 })])

    await store.tracker.save(A, "issue", [issue("i2", "Going")], NOW + 2)
    expect(chunksOf(database).map(({ id }) => id)).toEqual(["i1", "i2"])
  })

  it("leaves no chunk of a purged account, and the other's stay", async () => {
    const { store, database } = await fixture()
    await store.tracker.save(A, "issue", [issue("i1", "First")], NOW)
    await store.tracker.save(B, "issue", [issue("i1", "Second")], NOW)
    await embedAll(store)
    await store.accounts.purge(A)
    expect(chunksOf(database).map(({ account }) => account)).toEqual(["b"])
    expect(vectors(database)).toHaveLength(1)
  })

  it("cuts the chunks of items saved before, and drops the chunks of items gone", async () => {
    const { store, database } = await fixture()
    await store.tracker.save(A, "issue", [issue("i1", "Old"), issue("i2", "Older")], NOW)
    await store.tracker.save(A, "comment", [{ externalId: "c1", issue: "i1", body: "  ", updatedAt: NOW }], NOW)
    database.exec("DELETE FROM chunks WHERE chunkable_type = 'tracker_item'")
    database.exec("UPDATE tracker_items SET deleted_at = 1 WHERE external_id = 'i2'")
    database
      .prepare(
        "INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, " +
          "created_at, updated_at) SELECT 'tracker_item', id, 0, 0, 1, 'stale', 1, 1 FROM tracker_items " +
          "WHERE external_id = 'i2'",
      )
      .run()

    expect(await store.tracker.refreshChunks()).toEqual({ dropped: 1, added: 1 })
    expect(chunksOf(database).map(({ id }) => id)).toEqual(["i1"])
    expect(await store.tracker.refreshChunks()).toEqual({ dropped: 0, added: 0 })
  })

  it("finds the nearest live items of the accounts asked only, archived ones too, never deleted ones", async () => {
    const { store, database } = await fixture()
    await store.tracker.save(
      A,
      "issue",
      [issue("i1", "First"), { ...issue("i2", "Second"), archivedAt: NOW }, issue("i3", "Third")],
      NOW,
    )
    await store.tracker.save(B, "issue", [issue("i9", "Other account")], NOW)
    const waiting = await embedAll(store)
    expect(waiting).toHaveLength(4)
    await store.tracker.removeUnlisted(A, "issue", ["i1", "i2"], NOW + 1, NOW + 1)

    const all = Float32Array.from([0.5, 0.5, 0.5, 0.5])
    const found = await store.tracker.nearest(MODEL, all, { limit: 10, accounts: [A] })
    expect(found.map(({ item }) => item.record.externalId).sort()).toEqual(["i1", "i2"])
    expect(found.every(({ account }) => account.account === "a")).toBe(true)
    database.exec("UPDATE vector_indexes SET ready = 0")
    expect(await store.tracker.nearest(MODEL, all, { limit: 10, accounts: [A] })).toEqual(found)
    expect(await store.tracker.embedded(MODEL, [A])).toBe(true)
    expect(await store.tracker.embedded(MODEL, [{ provider: "fake-tracker", account: "none" }])).toBe(false)
  })
})
