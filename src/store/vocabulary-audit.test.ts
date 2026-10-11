import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { openStore } from "./store.js"

it("discovers reviewed similar labels and aliases without merging or changing the catalog", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "vocabulary-audit-")), "fixture.db") })
  try {
    const first = await store.knowledge.createTag("onboarding")
    const preview = await store.knowledge.tagPreflight("on-boarding", { kind: "topic" })
    const other = await store.knowledge.createTag("on-boarding", {
      kind: "topic",
      expectedCreationFingerprint: preview.creationFingerprint,
    })
    const before = await store.knowledge.vocabulary()
    expect(await store.knowledge.auditVocabulary()).toMatchObject({
      complete: true,
      pairs: [
        {
          left: { id: String(first.id), kind: "tag" },
          right: { id: String(other.id), kind: "topic" },
          by: "lexical",
        },
      ],
      semantic: "not-requested",
    })
    expect(await store.knowledge.vocabulary()).toEqual(before)
    expect(await store.knowledge.auditVocabulary({ maxComparisons: 1, limit: 1 })).toMatchObject({ complete: false })
    await store.knowledge.addVocabularyAlias({ kind: "tag", id: String(first.id) }, "arrival")
    const delivery = await store.knowledge.createTag("delivery")
    await store.knowledge.addVocabularyAlias({ kind: "tag", id: String(delivery.id) }, "arrivals")
    const audit = await store.knowledge.auditVocabulary()
    expect(audit.pairs.some((pair) => pair.left.id === String(first.id) && pair.right.id === String(delivery.id))).toBe(
      true,
    )
    expect(await store.knowledge.auditVocabulary({ kind: "topic" })).toMatchObject({ complete: true, pairs: [] })
    expect(await store.knowledge.auditVocabulary({ maxComparisons: 1 })).toMatchObject({
      complete: false,
      comparisons: 1,
    })
    for (const options of [
      { limit: 0 },
      { limit: 201 },
      { maxComparisons: 0 },
      { maxComparisons: 100001 },
      { minSimilarity: 0.2 },
      { minSimilarity: NaN },
    ])
      await expect(store.knowledge.auditVocabulary(options)).rejects.toMatchObject({ code: "validation_error" })
    const controller = new AbortController()
    controller.abort()
    await expect(store.knowledge.auditVocabulary({ signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    })
  } finally {
    await store.close()
  }
})
