import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { TagConsolidationOptions } from "../domain/tag-consolidation.js"
import { openCache } from "./open.js"
import { openSqlite } from "./sqlite/open.js"
import { vocabularyStoreOver } from "./sqlite/vocabulary.js"
import { type MessageStore, openStore } from "./store.js"

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "tag-consolidation-")), "fixture.db")
  const store: MessageStore = await openStore({ path, now: () => 3000 })
  opened.push(store)
  const source = await store.knowledge.createTag("arrival")
  const survivor = await store.knowledge.createTag("welcome")
  const topic = await store.knowledge.createTag("finance", { kind: "topic" })
  const database = await openCache(path)
  opened.push(database)
  database.exec(`INSERT INTO accounts(id,provider,external_id,created_at,updated_at) VALUES(400,'synthetic','fixture',1,1);
    INSERT INTO chats(id,account_id,external_id,kind,created_at,updated_at) VALUES(500,400,'fixture-chat','group',1,1)`)
  const fingerprint = async () => (await store.knowledge.vocabulary()).fingerprint
  const options = async (): Promise<TagConsolidationOptions> => ({
    sourceId: String(source.id),
    survivorId: String(survivor.id),
    expectedVocabularyFingerprint: await fingerprint(),
  })
  return { path, store, database, source, survivor, topic, options }
}

it("previews complete selected dependencies, overlaps and bounded samples without writing", async () => {
  const { path, store, database, source, survivor, options } = await fixture()
  await store.knowledge.addVocabularyAlias({ kind: "tag", id: String(source.id) }, "arriving")
  for (const [tag, author, origin] of [
    [source.id, 11, "manual"],
    [survivor.id, 12, "auto"],
  ] as const) {
    database
      .prepare(
        "INSERT INTO taggings(tag_id,taggable_type,taggable_id,source,author_type,author_id,created_at,updated_at) VALUES(?,'meeting',700,?,'person',?,1,2)",
      )
      .run(Number(tag), origin, author)
    database
      .prepare(
        "INSERT INTO auto_tag_claims(chat_id,tag_id,algorithm,score,fields,created_at,updated_at) VALUES(500,?,'fixture',0.9,'private evidence',1,2)",
      )
      .run(Number(tag))
  }
  database
    .prepare(
      "INSERT INTO links(from_type,from_id,to_type,to_id,kind,source,evidence,created_at,updated_at) VALUES('tag',?,'tag',?,'related','owner','private evidence',1,2)",
    )
    .run(Number(source.id), Number(survivor.id))
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  const before = digest(path)
  const input = await options()
  const preview = await store.knowledge.previewTagConsolidation({ ...input, sampleLimit: 1 })
  expect(preview).toMatchObject({
    source: { name: "arrival" },
    survivor: { name: "welcome" },
    assignments: {
      source: 1,
      survivor: 1,
      overlappingTargets: 1,
      byTargetType: [{ type: "meeting", source: 1, survivor: 1 }],
    },
    automaticClaims: { source: 1, survivor: 1, overlappingChats: 1 },
    aliases: { source: 1, survivor: 0 },
    links: { total: 1 },
    coverage: { completeWithinInspectedTables: true, rows: 6, samplesComplete: false, applySupported: false },
  })
  expect(preview.assignments.samples).toHaveLength(1)
  expect(preview.assignments.samples[0]).toMatchObject({ source: "manual", authorType: "person", authorId: "11" })
  expect(JSON.stringify(preview)).not.toContain("private evidence")
  expect(await store.knowledge.previewTagConsolidation({ ...input, sampleLimit: 2 })).toMatchObject({
    previewFingerprint: preview.previewFingerprint,
    coverage: { samplesComplete: true },
  })
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  expect(digest(path)).toEqual(before)
})

it("fingerprints all inspected provenance even when counts and vocabulary stay unchanged", async () => {
  const { store, database, source, options } = await fixture()
  database
    .prepare(
      "INSERT INTO taggings(tag_id,taggable_type,taggable_id,source,author_id,created_at,updated_at) VALUES(?,'document',700,'manual',11,1,2)",
    )
    .run(Number(source.id))
  const input = await options()
  const first = await store.knowledge.previewTagConsolidation(input)
  database.exec("UPDATE taggings SET author_id=12")
  const next = await store.knowledge.previewTagConsolidation(input)
  expect(next.vocabularyFingerprint).toBe(first.vocabularyFingerprint)
  expect(next.previewFingerprint).not.toBe(first.previewFingerprint)
  database
    .prepare(
      "INSERT INTO auto_tag_claims(chat_id,tag_id,algorithm,score,fields,created_at,updated_at) VALUES(500,?,'fixture',0.9,'one',1,2)",
    )
    .run(Number(source.id))
  const claim = await store.knowledge.previewTagConsolidation(input)
  database.exec("UPDATE auto_tag_claims SET fields='two'")
  expect((await store.knowledge.previewTagConsolidation(input)).previewFingerprint).not.toBe(claim.previewFingerprint)
})

it("rejects stale vocabulary, topics, missing IDs and invalid or unknown fields", async () => {
  const { store, source, topic, options } = await fixture()
  const input = await options()
  for (const fields of [
    { sourceId: "0" },
    { survivorId: "1 OR 1=1" },
    { sourceId: "9007199254740992" },
    { survivorId: String(source.id) },
    { expectedVocabularyFingerprint: "bad" },
    { maxRows: 0 },
    { maxRows: 20001 },
    { maxReadBytes: 0 },
    { maxReadBytes: 16777217 },
    { sampleLimit: NaN },
    { sampleLimit: 101 },
    { unexpected: true },
  ])
    await expect(store.knowledge.previewTagConsolidation({ ...input, ...fields })).rejects.toMatchObject({
      code: "validation_error",
    })
  await expect(store.knowledge.previewTagConsolidation({ ...input, sourceId: String(topic.id) })).rejects.toMatchObject(
    { code: "validation_error" },
  )
  await expect(store.knowledge.previewTagConsolidation({ ...input, sourceId: "999999" })).rejects.toMatchObject({
    code: "not_found",
  })
  const controller = new AbortController()
  controller.abort()
  await expect(store.knowledge.previewTagConsolidation({ ...input, signal: controller.signal })).rejects.toMatchObject({
    code: "cancelled",
  })
  await store.knowledge.addVocabularyAlias({ kind: "tag", id: String(source.id) }, "arriving")
  await expect(store.knowledge.previewTagConsolidation(input)).rejects.toMatchObject({
    code: "configuration_error",
    details: { reason: "vocabulary.stale" },
  })
})

it("refuses incomplete dependencies and oversized evidence before returning any preview", async () => {
  const { store, database, source, options } = await fixture()
  for (const id of [701, 702])
    database
      .prepare(
        "INSERT INTO taggings(tag_id,taggable_type,taggable_id,source,created_at,updated_at) VALUES(?,'note',?,'manual',1,2)",
      )
      .run(Number(source.id), id)
  const input = await options()
  await expect(store.knowledge.previewTagConsolidation({ ...input, maxRows: 1 })).rejects.toMatchObject({
    details: { reason: "vocabulary.consolidation-over-budget", table: "taggings" },
  })
  database
    .prepare(
      "INSERT INTO links(from_type,from_id,kind,source,evidence,created_at,updated_at) VALUES('tag',?,'related','owner',?,1,2)",
    )
    .run(Number(source.id), "x".repeat(20000))
  await expect(store.knowledge.previewTagConsolidation({ ...input, maxReadBytes: 10000 })).rejects.toMatchObject({
    details: { reason: "vocabulary.consolidation-over-budget", table: "links" },
  })
})

it("works on a query-only connection after reopen", async () => {
  const { path, store, options } = await fixture()
  const input = await options()
  const first = await store.knowledge.previewTagConsolidation(input)
  const context = { ...(await openSqlite(path, { readOnly: true })), now: () => 3000 }
  opened.push(context.database)
  expect(await vocabularyStoreOver(context).previewTagConsolidation(input)).toEqual(first)
})
