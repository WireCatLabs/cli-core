import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { TagConsolidationApplyOptions } from "../domain/tag-consolidation.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { searchNotesQuery } from "../services/notes-search.js"
import { openCache } from "./open.js"
import { openSqlite } from "./sqlite/open.js"
import { vocabularyStoreOver } from "./sqlite/vocabulary.js"
import { type MessageStore, openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of opened.splice(0)) await store.close()
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "tag-apply-")), "fixture.db")
  const store: MessageStore = await openStore({ path, now: () => 3000 })
  opened.push(store)
  const source = await store.knowledge.createTag("arrival")
  const survivor = await store.knowledge.createTag("welcome")
  const note = await store.notes.addNote({ text: "Synthetic meeting context" })
  await store.knowledge.addTags(null, { type: "note", id: note.id }, [source.name, survivor.name])
  await store.knowledge.addVocabularyAlias({ kind: "tag", id: String(source.id) }, "arriving")
  const database = await openCache(path)
  opened.push(database)
  database.prepare("UPDATE taggings SET source='agent',author_type='bot',author_id=1 WHERE tag_id=?").run(source.id)
  const reviewed = async (): Promise<TagConsolidationApplyOptions> => {
    const vocabulary = await store.knowledge.vocabulary()
    const input = {
      sourceId: String(source.id),
      survivorId: String(survivor.id),
      expectedVocabularyFingerprint: vocabulary.fingerprint,
    }
    const preview = await store.knowledge.previewTagConsolidation(input)
    return {
      ...input,
      by: "owner",
      expectedPreviewFingerprint: preview.previewFingerprint,
      idempotencyKey: "fixture-merge-1",
    }
  }
  return { path, store, database, source, survivor, note, reviewed }
}

it("applies one reviewed redirect, preserves overlapping attribution and retries with a text-free receipt", async () => {
  const { store, database, source, survivor, note, reviewed } = await fixture()
  const rows = database.prepare("SELECT * FROM taggings ORDER BY id").all()
  const aliases = database.prepare("SELECT * FROM aliases WHERE aliasable_type='tag' ORDER BY id").all()
  const input = await reviewed()
  const receipt = await store.knowledge.applyTagConsolidation(input)
  expect(await store.knowledge.addTags(null, { type: "note", id: note.id }, ["arrival"])).toEqual([])
  expect(receipt).toMatchObject({
    sourceId: String(source.id),
    survivorId: String(survivor.id),
    counts: { assignments: 2, aliases: 1, links: 0, automaticClaims: 0 },
  })
  expect(database.prepare("SELECT * FROM taggings ORDER BY id").all()).toEqual(rows)
  expect(database.prepare("SELECT * FROM aliases WHERE aliasable_type='tag' ORDER BY id").all()).toEqual(aliases)
  expect(await store.knowledge.tags(null, { type: "note", id: note.id })).toEqual(["welcome"])
  expect(await store.knowledge.tags(null, { type: "note", id: note.id }, "arrival")).toEqual(["welcome"])
  const catalog = await store.knowledge.vocabulary()
  expect(catalog.entries).toHaveLength(1)
  expect(catalog.entries[0]).toMatchObject({
    id: String(survivor.id),
    name: "welcome",
    usageCount: 1,
    aliases: expect.arrayContaining([{ id: `tag:${source.id}`, name: "arrival", retained: true }]),
  })
  for (const name of ["arrival", "arriving", "welcome"]) {
    const resolved = await store.knowledge.resolveVocabulary(name)
    expect(resolved.matches.map((entry) => entry.id)).toEqual([String(survivor.id)])
    expect(await store.knowledge.tagPreflight(name)).toMatchObject({
      disposition: "reuse",
      existing: { id: String(survivor.id) },
    })
  }
  const receiptText = JSON.stringify(database.prepare("SELECT * FROM tag_consolidations").all())
  expect(receiptText).not.toContain("arrival")
  expect(receiptText).not.toContain("Synthetic meeting context")
  expect(await store.knowledge.applyTagConsolidation(input)).toEqual(receipt)
  await expect(store.knowledge.applyTagConsolidation({ ...input, survivorId: "99999" })).rejects.toMatchObject({
    code: "configuration_error",
  })
  await expect(
    store.knowledge.removeVocabularyAlias({ kind: "tag", id: String(survivor.id) }, `tag:${source.id}`),
  ).rejects.toMatchObject({ code: "validation_error" })
  const realAlias = catalog.entries[0]?.aliases.find((alias) => !alias.retained)
  expect(realAlias).toBeDefined()
  await store.knowledge.removeVocabularyAlias({ kind: "tag", id: String(survivor.id) }, realAlias?.id as string)
  expect((await store.knowledge.resolveVocabulary("arriving")).matches).toEqual([])
  expect(await store.knowledge.removeTags(null, { type: "note", id: note.id }, ["arrival"])).toEqual(["welcome"])
  expect(database.prepare("SELECT count(*) AS n FROM taggings").get()).toEqual({ n: 0 })
  expect(await store.knowledge.tags(null, { type: "note", id: note.id })).toEqual([])
})

it("rejects stale provenance and invalid authority/arguments before writing any redirect or receipt", async () => {
  const { store, database, reviewed } = await fixture()
  const input = await reviewed()
  for (const fields of [
    { by: "agent" },
    { expectedPreviewFingerprint: "bad" },
    { idempotencyKey: "contains spaces" },
    { unknown: true },
    { sampleLimit: 1 },
  ])
    await expect(
      store.knowledge.applyTagConsolidation({ ...input, ...fields } as TagConsolidationApplyOptions),
    ).rejects.toMatchObject({ code: fields.by ? "permission_error" : "validation_error" })
  const aborted = AbortSignal.abort()
  await expect(store.knowledge.applyTagConsolidation({ ...input, signal: aborted })).rejects.toMatchObject({
    code: "cancelled",
  })
  database.prepare("UPDATE taggings SET author_id=2 WHERE source='agent'").run()
  await expect(store.knowledge.applyTagConsolidation(input)).rejects.toMatchObject({
    code: "configuration_error",
    details: { reason: "vocabulary.stale" },
  })
  expect(database.prepare("SELECT count(*) AS n FROM tag_redirects").get()).toEqual({ n: 0 })
  expect(database.prepare("SELECT count(*) AS n FROM tag_consolidations").get()).toEqual({ n: 0 })
})

it("keeps canonical aliases through chained reviews, meeting/note search and file/subfolder tag replacement", async () => {
  const { store, database, source, survivor, note, reviewed } = await fixture()
  const folder = await store.notes.addFolder({ name: "Synthetic archive" })
  const file = (
    await store.notes.saveFileNote({
      folderId: folder.id,
      path: "series/session.md",
      title: "Synthetic session",
      text: "Synthetic meeting context",
    })
  ).note
  await store.notes.replaceFileTags(file.id, [source.name, survivor.name])
  await store.knowledge.addTags(null, { type: "folder", id: folder.id, path: "series" }, [source.name, survivor.name])
  const key = { provider: "example", account: "fixture" }
  const accountId = await store.accounts.saveAccount(key, { name: "Synthetic fixture" })
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  const saved = await store.meetings.saveMeeting(input)
  await store.knowledge.addTags(key, { type: "meeting", id: String(saved.meeting.id) }, [source.name, survivor.name])
  const firstInput = await reviewed()
  const firstReceipt = await store.knowledge.applyTagConsolidation(firstInput)
  for (const name of ["arrival", "arriving", "welcome"]) {
    expect(
      (await searchNotesQuery(store, { text: `tag:${name}`, limit: 10, exact: true })).items
        .map((row) => row.ref)
        .sort(),
    ).toEqual([file.ref, note.ref].sort())
    expect(await store.knowledge.tags(null, { type: "folder", id: folder.id, path: "series" })).toEqual(["welcome"])
    expect(await store.knowledge.tags(null, { type: "folder", id: folder.id, path: "series" }, name)).toEqual([
      "welcome",
    ])
  }
  await store.meetings.indexSearch({ accountId })
  expect((await store.meetings.searchHits("Ship", { accountId, tagId: source.id })).items).toHaveLength(1)
  const next = await store.knowledge.createTag("harbour")
  const vocabulary = await store.knowledge.vocabulary()
  const selection = {
    sourceId: String(survivor.id),
    survivorId: String(next.id),
    expectedVocabularyFingerprint: vocabulary.fingerprint,
  }
  const preview = await store.knowledge.previewTagConsolidation(selection)
  expect(preview).toMatchObject({
    sourceMemberIds: [String(source.id), String(survivor.id)],
    assignments: { source: 6, survivor: 0 },
  })
  const receipt = await store.knowledge.applyTagConsolidation({
    ...selection,
    expectedPreviewFingerprint: preview.previewFingerprint,
    by: "owner",
    idempotencyKey: "fixture-merge-2",
  })
  expect(receipt.sourceMemberIds).toEqual([String(source.id), String(survivor.id)])
  expect(await store.knowledge.applyTagConsolidation(firstInput)).toEqual(firstReceipt)
  const currentFingerprint = (await store.knowledge.vocabulary()).fingerprint
  await expect(
    store.knowledge.previewTagConsolidation({
      sourceId: String(source.id),
      survivorId: String(next.id),
      expectedVocabularyFingerprint: currentFingerprint,
    }),
  ).rejects.toMatchObject({ code: "validation_error" })
  expect(database.prepare("SELECT source_id,survivor_id FROM tag_redirects ORDER BY source_id").all()).toEqual([
    { source_id: source.id, survivor_id: next.id },
    { source_id: survivor.id, survivor_id: next.id },
  ])
  expect((await store.knowledge.resolveVocabulary("arrival")).matches.map((row) => row.id)).toEqual([String(next.id)])
  expect(await store.knowledge.tags(null, { type: "note", id: note.id })).toEqual(["harbour"])
  await store.notes.replaceFileTags(file.id, ["arrival"])
  expect(await store.notes.noteTags(file.ref)).toEqual([{ tag: "harbour", origin: "file" }])
  expect(database.prepare("SELECT count(*) AS n FROM taggings WHERE taggable_type='document'").get()).toEqual({ n: 2 })
  await store.notes.replaceFileTags(file.id, [])
  expect(await store.notes.noteTags(file.ref)).toEqual([])
  await store.knowledge.removeTags(null, { type: "folder", id: folder.id, path: "series" }, ["arrival"])
  expect(await store.knowledge.tags(null, { type: "folder", id: folder.id, path: "series" })).toEqual([])
  await store.notes.removeNote(note.id)
  expect(database.prepare("SELECT count(*) AS n FROM taggings WHERE taggable_type='note'").get()).toEqual({ n: 0 })
  await store.accounts.purge(key)
  expect(database.prepare("SELECT count(*) AS n FROM taggings WHERE taggable_type='meeting'").get()).toEqual({ n: 0 })
  expect(database.prepare("SELECT count(*) AS n FROM tag_consolidations").get()).toEqual({ n: 2 })
})

it("groups automatic/manual claims but withdraws only the explicitly selected origin across retained IDs", async () => {
  const { store, database, source, survivor, reviewed } = await fixture()
  const key = { provider: "example", account: "claims" }
  await store.chats.saveChats(key, [
    {
      id: "chat",
      title: "Synthetic group",
      kind: "group",
      unreadCount: 0,
      lastMessageAt: null,
      participantsCount: null,
    },
  ])
  await store.tags.addTags(key, { type: "chat", chatId: "chat" }, [source.name])
  await store.chats.replaceAutoTags(key, "chat", "fixture", [
    { tag: source.name, score: 0.6, fields: ["title"] },
    { tag: survivor.name, score: 0.9, fields: ["description"] },
  ])
  const claims = database.prepare("SELECT * FROM canonical_auto_tag_claims ORDER BY tag_id").all()
  await store.knowledge.applyTagConsolidation(await reviewed())
  expect(database.prepare("SELECT * FROM canonical_auto_tag_claims ORDER BY tag_id").all()).toEqual(claims)
  expect(await store.tags.tags(key)).toMatchObject([{ tag: "welcome", sources: ["manual", "auto"] }])
  expect(await store.tags.removeTags(key, { type: "chat", chatId: "chat" }, ["arrival"], "auto")).toEqual(["arrival"])
  expect((await store.tags.tags(key)).map((row) => row.tag)).toEqual(["welcome"])
  expect(database.prepare("SELECT count(*) AS n FROM canonical_auto_tag_claims").get()).toEqual({ n: 0 })
  await store.chats.replaceAutoTags(key, "chat", "fixture", [{ tag: "arrival", score: 0.5, fields: ["title"] }])
  await store.tags.removeTags(key, { type: "chat", chatId: "chat" }, ["welcome"], "manual")
  expect(await store.tags.tags(key)).toMatchObject([{ tag: "welcome", sources: ["auto"] }])
  await store.chats.replaceAutoTags(key, "chat", "fixture", [])
  expect(await store.tags.tags(key)).toEqual([])
  expect(database.prepare("SELECT count(*) AS n FROM canonical_auto_tag_claims").get()).toEqual({ n: 0 })
})

it("rolls back both redirect and receipt when cancellation arrives after persistence but before commit", async () => {
  const { path, store, database, source, survivor, reviewed } = await fixture()
  const input = await reviewed(),
    controller = new AbortController()
  const context = { ...(await openSqlite(path)), now: () => 3000 }
  opened.push(context.database)
  const prepare = context.database.prepare.bind(context.database)
  let reachedReceipt = false
  vi.spyOn(context.database, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql)
    if (!sql.startsWith("INSERT INTO tag_consolidations")) return statement
    return {
      ...statement,
      get: (...args) => {
        const row = statement.get(...args)
        reachedReceipt = true
        controller.abort()
        return row
      },
    }
  })
  await expect(
    vocabularyStoreOver(context).applyTagConsolidation({ ...input, signal: controller.signal }),
  ).rejects.toMatchObject({ code: "cancelled" })
  expect(reachedReceipt).toBe(true)
  expect(database.prepare("SELECT count(*) AS n FROM tag_redirects").get()).toEqual({ n: 0 })
  expect(database.prepare("SELECT count(*) AS n FROM tag_consolidations").get()).toEqual({ n: 0 })
  expect((await store.knowledge.vocabulary()).entries.map((row) => row.id)).toEqual([
    String(source.id),
    String(survivor.id),
  ])
})
