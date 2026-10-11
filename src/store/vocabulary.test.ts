import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { normalizeVocabularyName, vocabularySimilarity } from "../domain/vocabulary.js"
import { type MessageStore, openStore } from "./store.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "vocabulary-test-")), "fixture.db")
  const store = await openStore({ path, now: () => 3000 })
  opened.push(store)
  const project = await store.knowledge.addProject({ name: "Harbour Example", key: "HARBOUR", scope: "work" })
  const other = await store.knowledge.addProject({ name: "Lighthouse Example", key: "LIGHT", scope: "personal" })
  const tag = await store.knowledge.createTag("onboarding")
  const topic = await store.knowledge.createTag("budget", { kind: "topic" })
  return { path, store, project, other, tag, topic }
}

describe("canonical vocabulary", () => {
  it("keeps exact Unicode name normalization distinct from fuzzy or accent-insensitive search", () => {
    expect(normalizeVocabularyName("  HARBOUR   EXAMPLE ")).toBe("harbour example")
    expect(normalizeVocabularyName("ＡＢＣ")).toBe("abc")
    expect(normalizeVocabularyName("an\u0303o")).toBe("año")
    expect(normalizeVocabularyName("año")).not.toBe(normalizeVocabularyName("ano"))
    expect(normalizeVocabularyName("ёлка")).not.toBe(normalizeVocabularyName("елка"))
    expect(vocabularySimilarity("on-boarding", "onboarding")).toBeGreaterThan(0.65)
    expect(vocabularySimilarity("budget", "delivery")).toBeLessThan(0.65)
    expect(vocabularySimilarity("tag-name", "tag name")).toBe(1)
    expect(vocabularySimilarity("a", "b")).toBe(0)
    expect(vocabularySimilarity("!!!", "a")).toBe(0)
    for (const value of ["", "  ", "a\0b", "a\u200db", "x".repeat(201)])
      expect(() => normalizeVocabularyName(value)).toThrowError(expect.objectContaining({ code: "validation_error" }))
  })

  it("resolves explicit project aliases after reopening without guessing a fuzzy match", async () => {
    const { store, path, project } = await fixture()
    const target = { kind: "project" as const, id: project.id }
    const first = await store.knowledge.addVocabularyAlias(target, "Гавань пример")
    expect(first).toMatchObject({ target, changed: true, alias: { name: "Гавань пример" } })
    expect(await store.knowledge.addVocabularyAlias(target, " ГАВАНЬ   ПРИМЕР ")).toMatchObject({ changed: false })
    expect(await store.knowledge.addVocabularyAlias(target, "harbour")).toMatchObject({ changed: false, alias: null })
    const reopened = await openStore({ path, now: () => 4000 })
    opened.push(reopened)
    expect(await reopened.knowledge.resolveVocabulary("ГАВАНЬ ПРИМЕР", { kind: "project" })).toMatchObject({
      ambiguous: false,
      matches: [{ id: project.id, name: "Harbour Example" }],
    })
    expect((await reopened.knowledge.resolveVocabulary("Harbour Exampl", { kind: "project" })).matches).toEqual([])
  })

  it("rejects alias collisions with another alias, canonical name or project key atomically", async () => {
    const { store, project, other } = await fixture()
    const target = { kind: "project" as const, id: project.id }
    await store.knowledge.addVocabularyAlias(target, "shared-example")
    for (const name of ["shared-example", "HARBOUR", "Harbour Example"])
      await expect(store.knowledge.addVocabularyAlias({ kind: "project", id: other.id }, name)).rejects.toMatchObject({
        code: "configuration_error",
        details: { reason: "vocabulary_alias_conflict" },
      })
    expect(
      (await store.knowledge.vocabulary({ kind: "project" })).entries.find((entry) => entry.id === other.id)?.aliases,
    ).toEqual([])
  })

  it("keeps scoped previews from hiding alias conflicts and blocks new projects shadowing aliases", async () => {
    const { store, project, other } = await fixture()
    await store.knowledge.addVocabularyAlias({ kind: "project", id: other.id }, "shared-name")
    const preview = await store.knowledge.vocabulary({ kind: "project", scope: "work" })
    await expect(
      store.knowledge.addVocabularyAlias({ kind: "project", id: project.id }, "shared-name", {
        expectedFingerprint: preview.fingerprint,
      }),
    ).rejects.toMatchObject({ details: { reason: "vocabulary_alias_conflict" } })
    await expect(store.knowledge.addProject({ name: "Shared-name", key: "NEW", scope: "work" })).rejects.toMatchObject({
      details: { reason: "vocabulary_alias_conflict" },
    })
    await store.knowledge.addVocabularyAlias({ kind: "project", id: other.id }, "NEW")
    await expect(store.knowledge.addProject({ name: "New Example", key: "NEW" })).rejects.toMatchObject({
      details: { reason: "vocabulary_alias_conflict" },
    })
    expect((await store.knowledge.projects()).length).toBe(2)
  })

  it("reports canonical-name ambiguity and scopes project reads explicitly", async () => {
    const { store, project } = await fixture()
    const duplicate = await store.knowledge.addProject({ name: "Harbour Example", key: "HARBOUR2", scope: "personal" })
    expect(await store.knowledge.resolveVocabulary("Harbour Example", { kind: "project" })).toMatchObject({
      ambiguous: true,
      matches: [{ id: project.id }, { id: duplicate.id }],
    })
    expect(
      await store.knowledge.resolveVocabulary("Harbour Example", { kind: "project", scope: "work" }),
    ).toMatchObject({
      ambiguous: false,
      matches: [{ id: project.id }],
    })
  })

  it("protects alias changes with a scoped preview fingerprint and refuses agent canonical writes", async () => {
    const { store, project } = await fixture()
    const target = { kind: "project" as const, id: project.id }
    const preview = await store.knowledge.vocabulary({ kind: "project", scope: "work" })
    const added = await store.knowledge.addVocabularyAlias(target, "harbour-example", {
      expectedFingerprint: preview.fingerprint,
    })
    await expect(
      store.knowledge.addVocabularyAlias(target, "harbour-old", { expectedFingerprint: preview.fingerprint }),
    ).rejects.toMatchObject({
      code: "configuration_error",
      details: { reason: "stale_vocabulary" },
    })
    await expect(store.knowledge.addVocabularyAlias(target, "agent-alias", { by: "agent" })).rejects.toMatchObject({
      code: "permission_error",
    })
    await expect(
      store.knowledge.removeVocabularyAlias(target, added.alias?.id as string, { by: "agent" }),
    ).rejects.toMatchObject({ code: "permission_error" })
    await expect(
      store.knowledge.addVocabularyAlias(target, "bad-preview", { expectedFingerprint: "bad" }),
    ).rejects.toMatchObject({ code: "validation_error" })
    expect(
      (await store.knowledge.vocabulary({ kind: "project" })).entries.find((entry) => entry.id === project.id)?.aliases,
    ).toHaveLength(1)
  })

  it("removes only an alias held by the selected canonical target, with replayable acknowledgments", async () => {
    const { store, project, other } = await fixture()
    const target = { kind: "project" as const, id: project.id }
    const added = await store.knowledge.addVocabularyAlias(target, "harbour-example")
    const aliasId = added.alias?.id
    if (!aliasId) throw new Error("missing invented alias")
    expect(await store.knowledge.removeVocabularyAlias({ kind: "project", id: other.id }, aliasId)).toMatchObject({
      changed: false,
    })
    expect(await store.knowledge.removeVocabularyAlias(target, aliasId)).toMatchObject({ changed: true })
    expect(await store.knowledge.removeVocabularyAlias(target, aliasId)).toMatchObject({ changed: false })
    expect((await store.knowledge.resolveVocabulary("harbour-example", { kind: "project" })).matches).toEqual([])
  })

  it("uses topic aliases while retaining their kind and proposes near labels without creating them", async () => {
    const { store, tag, topic } = await fixture()
    await store.knowledge.addVocabularyAlias({ kind: "topic", id: String(topic.id) }, "Бюджет пример")
    expect(await store.knowledge.tagPreflight("БЮДЖЕТ ПРИМЕР", { kind: "topic" })).toMatchObject({
      disposition: "reuse",
      existing: { kind: "topic", id: String(topic.id), name: "budget" },
      semantic: "not-requested",
    })
    await expect(store.knowledge.tagPreflight("Бюджет пример", { kind: "tag" })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(await store.knowledge.tagPreflight("on-boarding")).toMatchObject({
      disposition: "review",
      existing: null,
      suggestions: [{ entry: { id: String(tag.id) }, by: "lexical" }],
    })
    expect(await store.knowledge.tagPreflight("onboarding")).toMatchObject({ disposition: "reuse", suggestions: [] })
    expect(await store.knowledge.tagPreflight("unrelated-tag")).toMatchObject({ disposition: "create" })
    expect((await store.knowledge.vocabulary()).entries).toHaveLength(4)
  })

  it("reuses canonical topic aliases for labels and prevents creating a duplicate tag from an alias", async () => {
    const { store, project, topic } = await fixture()
    const target = { type: "project" as const, id: project.id }
    await store.knowledge.addVocabularyAlias({ kind: "topic", id: String(topic.id) }, "Бюджет пример")
    expect(await store.knowledge.addTags(null, target, ["БЮДЖЕТ ПРИМЕР", "budget"])).toEqual(["budget"])
    expect(await store.knowledge.tags(null, target)).toEqual(["budget"])
    await store.knowledge.setMainTopic(null, target, "Бюджет пример")
    expect((await store.knowledge.labelled(null, { tag: "Бюджет пример", type: "project" })).items).toHaveLength(1)
    await expect(store.knowledge.createTag("Бюджет пример")).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "tag_name_clash" },
    })
    expect((await store.knowledge.vocabulary({ kind: "topic" })).entries[0]?.usageCount).toBe(1)
    expect(await store.knowledge.removeTags(null, target, ["Бюджет пример"])).toEqual(["budget"])
  })

  it("keeps unsupported legacy display names from breaking unrelated canonical lookups", async () => {
    const { store, project } = await fixture()
    const legacy = await store.knowledge.addProject({ name: "Legacy\nExample", key: "LEGACY" })
    expect((await store.knowledge.resolveVocabulary("HARBOUR", { kind: "project" })).matches[0]?.id).toBe(project.id)
    expect((await store.knowledge.resolveVocabulary("LEGACY", { kind: "project" })).matches[0]?.id).toBe(legacy.id)
    expect(
      await store.knowledge.addVocabularyAlias({ kind: "project", id: legacy.id }, "legacy-example"),
    ).toMatchObject({ changed: true })
  })

  it("bounds catalog work before hydrating names and preserves cancellation without writes", async () => {
    const { store, project } = await fixture()
    await expect(store.knowledge.vocabulary({ maxEntries: 1 })).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "vocabulary_entry_budget" },
    })
    await expect(store.knowledge.vocabulary({ maxReadBytes: 1 })).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "vocabulary_byte_budget" },
    })
    for (const options of [
      { maxEntries: 0 },
      { maxEntries: 20_001 },
      { maxReadBytes: 0 },
      { maxReadBytes: 16_777_217 },
    ])
      await expect(store.knowledge.vocabulary(options)).rejects.toMatchObject({ code: "validation_error" })
    const controller = new AbortController()
    controller.abort()
    await expect(store.knowledge.vocabulary({ signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" })
    await expect(
      store.knowledge.addVocabularyAlias({ kind: "project", id: project.id }, "cancelled-name", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" })
    expect((await store.knowledge.resolveVocabulary("cancelled-name")).matches).toEqual([])
    await expect(
      store.knowledge.addVocabularyAlias({ kind: "project", id: "999999" }, "unknown"),
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(store.knowledge.addVocabularyAlias({ kind: "project", id: "0" }, "invalid")).rejects.toMatchObject({
      code: "validation_error",
    })
  })
})
