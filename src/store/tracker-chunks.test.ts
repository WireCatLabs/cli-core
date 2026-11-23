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

    expect(await store.tracker.refreshChunks({ until: () => true })).toEqual({ dropped: 1, added: 0, left: true })
    expect(await store.tracker.refreshChunks()).toEqual({ dropped: 0, added: 1, left: false })
    expect(chunksOf(database).map(({ id }) => id)).toEqual(["i1"])
    expect(await store.tracker.refreshChunks({ until: () => true })).toEqual({ dropped: 0, added: 0, left: false })
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

  it("ranks past the index's first candidates as the scan does, by distinct scores", async () => {
    const { store, database } = await fixture()
    const many = Array.from({ length: 120 }, (_, at) => issue(`m${at}`, `Item number ${at}`))
    await store.tracker.save(A, "issue", many, NOW)
    const waiting = await store.tracker.chunksToEmbed(MODEL, { limit: 500 })
    const angle = (at: number) => (at / waiting.length) * (Math.PI / 2)
    await store.vectors.saveVectors(
      MODEL,
      4,
      waiting.map(({ hash }, at) => ({
        hash,
        vector: Float32Array.from([Math.cos(angle(at)), Math.sin(angle(at)), 0, 0]),
      })),
    )
    const query = Float32Array.from([Math.cos(0.3), Math.sin(0.3), 0, 0])
    const indexed = await store.tracker.nearest(MODEL, query, { limit: 30, accounts: [A] })
    expect(indexed).toHaveLength(30)
    expect(new Set(indexed.map(({ score }) => score.toFixed(6))).size).toBe(30)
    database.exec("UPDATE vector_indexes SET ready = 0")
    expect(await store.tracker.nearest(MODEL, query, { limit: 30, accounts: [A] })).toEqual(indexed)
  })

  const comment = (externalId: string, body: string, on = "i1"): TrackerRecords["comment"] => ({
    externalId,
    issue: on,
    body,
    updatedAt: NOW,
  })
  const textsOf = async (store: MessageStore) =>
    (await store.tracker.chunksToEmbed(MODEL, { limit: 100 })).map(({ text }) => text).sort()

  it("embeds a comment after its issue's key and title, and no comment too short to say anything", async () => {
    const { store, database } = await fixture()
    await store.tracker.save(A, "issue", [issue("i1", "Login loops on Android")], NOW)
    await store.tracker.save(
      A,
      "comment",
      [
        comment("c1", "Fixed by clearing the token cache"),
        comment("c2", "LGTM"),
        comment("c3", "+1, тоже вижу"),
        comment("c4", "  fifteen chars \n"),
        comment("c5", "sixteen chars ok"),
        comment("c6", "👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍"),
      ],
      NOW,
    )
    expect(await textsOf(store)).toEqual([
      "I1 Login loops on Android\n\nFixed by clearing the token cache",
      "I1 Login loops on Android\n\nsixteen chars ok",
      "Login loops on Android\n\n",
    ])
    expect(chunksOf(database).map(({ id }) => id)).toEqual(["c1", "c5", "i1"])
    const found = await store.tracker.find({ words: ["LGTM"], accounts: [A] })
    expect(found.items.map(({ item }) => item.record.externalId)).toEqual(["c2"])
    const byTitle = await store.tracker.find({ words: ["Android"], accounts: [A] })
    expect(byTitle.items.map(({ item }) => item.record.externalId)).toEqual(["i1"])

    database.exec("DELETE FROM chunks WHERE chunkable_type = 'tracker_item'")
    expect(await store.tracker.refreshChunks()).toEqual({ dropped: 0, added: 3, left: false })
    expect(await store.tracker.refreshChunks()).toEqual({ dropped: 0, added: 0, left: false })
  })

  it("cuts a comment again when its issue arrives, is renamed or moves, never when it keeps its name", async () => {
    const { store, database } = await fixture()
    await store.tracker.save(A, "comment", [comment("c1", "Fixed by clearing the token cache")], NOW)
    expect(await textsOf(store)).toEqual(["Fixed by clearing the token cache"])

    await store.tracker.save(A, "issue", [issue("i1", "Login loops")], NOW)
    await embedAll(store)
    const first = chunksOf(database).find(({ id }) => id === "c1")?.hash
    expect(await store.tracker.chunksToEmbed(MODEL, { limit: 100 })).toEqual([])

    await store.tracker.save(A, "issue", [issue("i1", "Login loops", "Now with a description")], NOW + 1)
    expect(chunksOf(database).find(({ id }) => id === "c1")?.hash).toBe(first)

    await store.tracker.save(A, "issue", [issue("i1", "Login loops on Android")], NOW + 2)
    expect(vectors(database)).not.toContain(first)
    await store.tracker.save(A, "issue", [{ ...issue("i1", "Login loops on Android"), key: "MOB-4" }], NOW + 3)
    expect((await textsOf(store)).filter((text) => text.endsWith("cache"))).toEqual([
      "MOB-4 Login loops on Android\n\nFixed by clearing the token cache",
    ])
  })

  it("cuts the comments of a store cut before once, releasing the old vectors", async () => {
    const { store, database } = await fixture()
    await store.tracker.save(A, "issue", [issue("i1", "Login loops")], NOW)
    await store.tracker.save(
      A,
      "comment",
      [comment("c1", "Fixed by clearing the token cache"), comment("c2", "ok")],
      NOW,
    )
    await store.tracker.refreshChunks()
    await embedAll(store)
    const kept = new Set(vectors(database))
    // As 0.730 left it: the comments cut from their body alone, the short one too, each with a vector.
    database.exec("DELETE FROM store_settings WHERE key = 'tracker_chunks_cut'")
    database
      .prepare(
        "INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, " +
          "created_at, updated_at) SELECT 'tracker_item', id, 0, 0, 2, 'old-short', 1, 1 FROM tracker_items " +
          "WHERE external_id = 'c2'",
      )
      .run()
    database.exec(
      "UPDATE chunks SET content_hash = 'old-long' WHERE content_hash NOT IN ('old-short') AND " +
        "chunkable_id = (SELECT id FROM tracker_items WHERE external_id = 'c1')",
    )
    await store.vectors.saveVectors(MODEL, 4, [
      { hash: "old-long", vector: unit(0) },
      { hash: "old-short", vector: unit(1) },
    ])

    expect(await store.tracker.refreshChunks()).toEqual({ dropped: 0, added: 2, left: false })
    expect(chunksOf(database).map(({ id }) => id)).toEqual(["c1", "i1"])
    expect(new Set(vectors(database))).toEqual(kept)
    expect(await store.tracker.refreshChunks()).toEqual({ dropped: 0, added: 0, left: false })
  })
})
