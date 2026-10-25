import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openStore as openLegacyStore } from "@wirecat/cli-core-legacy-tags/store"
import { afterEach, expect, it } from "vitest"
import { migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

it("serializes the structural upgrade and refuses actual old SDK tag/rekey writes without losing attribution", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "tags-version30-")), "fixture.db")
  const old = await openLegacyStore({ path, now: () => 1000 })
  opened.push(old)
  const key = { provider: "example", account: "fixture" }
  const chat = (id: string) => ({
    id,
    title: `Synthetic ${id}`,
    kind: "group" as const,
    unreadCount: 0,
    lastMessageAt: null,
    participantsCount: null,
  })
  await old.chats.saveChats(key, [chat("one"), chat("two")])
  await old.tags.addTags(key, { type: "chat", chatId: "one" }, ["arrival"])
  await old.tags.addTags(key, { type: "chat", chatId: "two" }, ["welcome"])
  await old.chats.replaceAutoTags(key, "one", "fixture", [{ tag: "arrival", score: 0.6, fields: ["title"] }])
  await old.chats.replaceAutoTags(key, "two", "fixture", [{ tag: "welcome", score: 0.9, fields: ["description"] }])
  const reader = await openCache(path),
    upgrader = await openCache(path)
  opened.push(reader, upgrader)
  const cached = reader.prepare("SELECT name FROM tags ORDER BY id")
  expect(cached.all()).toEqual([{ name: "arrival" }, { name: "welcome" }])
  expect(reader.prepare("SELECT max(version) AS version FROM schema_migrations").get()).toEqual({ version: 29 })
  upgrader.exec("PRAGMA busy_timeout=1")
  reader.exec("BEGIN IMMEDIATE")
  expect(() => migrate(upgrader)).toThrow()
  reader.exec("ROLLBACK; BEGIN")
  const snapshot = cached.all()
  migrate(upgrader)
  expect(cached.all()).toEqual(snapshot)
  expect(() => reader.exec("UPDATE tags SET updated_at=2")).toThrow()
  reader.exec("ROLLBACK")
  expect(() => cached.all()).toThrow(/tags/)
  expect(
    upgrader.prepare("SELECT version,min_compatible FROM schema_migrations ORDER BY version DESC LIMIT 1").get(),
  ).toEqual({ version: 30, min_compatible: 30 })
  for (const table of ["taggings", "canonical_auto_tag_claims"])
    expect(
      upgrader
        .prepare(`PRAGMA foreign_key_list(${table})`)
        .all()
        .some((row) => row.table === "canonical_tags"),
    ).toBe(true)
  const current = await openStore({ path, now: () => 3000 })
  opened.push(current)
  const vocabulary = await current.knowledge.vocabulary()
  const source = vocabulary.entries.find((row) => row.name === "arrival"),
    survivor = vocabulary.entries.find((row) => row.name === "welcome")
  if (!source || !survivor) throw Error("synthetic labels missing")
  const options = {
    sourceId: source.id,
    survivorId: survivor.id,
    expectedVocabularyFingerprint: vocabulary.fingerprint,
  }
  const preview = await current.knowledge.previewTagConsolidation(options)
  const before = () => ({
    tags: upgrader.prepare("SELECT * FROM canonical_tags ORDER BY id").all(),
    assignments: upgrader.prepare("SELECT * FROM taggings ORDER BY id").all(),
    claims: upgrader.prepare("SELECT * FROM canonical_auto_tag_claims ORDER BY chat_id,tag_id").all(),
    chats: upgrader.prepare("SELECT * FROM chats ORDER BY id").all(),
  })
  const retained = before()
  await current.knowledge.applyTagConsolidation({
    ...options,
    expectedPreviewFingerprint: preview.previewFingerprint,
    by: "owner",
    idempotencyKey: "version30-upgrade",
  })
  expect(before()).toEqual(retained)
  const refused = [
    () => old.tags.tags(key),
    () => old.tags.addTags(key, { type: "chat", chatId: "one" }, ["arrival"]),
    () => old.tags.removeTags(key, { type: "chat", chatId: "one" }, ["arrival"]),
    () => old.chats.replaceAutoTags(key, "one", "fixture", []),
    () => old.chats.replaceAutoTags(key, "one", "fixture", [{ tag: "arrival", score: 1, fields: ["title"] }]),
    () => old.chats.rekeyChat(key, "one", "two"),
    () => old.knowledge.addVocabularyAlias({ kind: "tag", id: source.id }, "arriving"),
  ]
  for (const operation of refused) {
    await expect(operation()).rejects.toThrow(/tags|auto_tag_claims/)
    expect(before()).toEqual(retained)
  }
  await expect(openLegacyStore({ path })).rejects.toMatchObject({ code: "configuration_error" })
  await expect(openLegacyStore({ path, readOnly: true })).rejects.toMatchObject({ code: "configuration_error" })
  expect((await current.tags.tags(key)).map((row) => row.tag)).toEqual(["welcome", "welcome"])
  await old.accounts.purge(key)
  expect(upgrader.prepare("SELECT count(*) AS n FROM taggings").get()).toEqual({ n: 0 })
  expect(upgrader.prepare("SELECT count(*) AS n FROM canonical_auto_tag_claims").get()).toEqual({ n: 0 })
  expect(upgrader.prepare("SELECT count(*) AS n FROM tag_consolidations").get()).toEqual({ n: 1 })
})
