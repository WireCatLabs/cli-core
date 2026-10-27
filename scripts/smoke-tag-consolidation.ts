import assert from "node:assert/strict"
import { join } from "node:path"
import { openStore as openLegacyStore } from "@wirecat/cli-core-legacy-tags/store"
import { openStore } from "../src/store/index.js"
import { scratch } from "./scratch.js"

export const smokeTagConsolidation = async () => {
  const path = join(scratch("tag-consolidation-smoke-"), "fixture.db")
  const legacy = await openLegacyStore({ path })
  try {
    const source = await legacy.knowledge.createTag("arrival")
    const survivor = await legacy.knowledge.createTag("welcome")
    const note = await legacy.notes.addNote({ text: "Synthetic tag smoke" })
    await legacy.knowledge.addTags(null, { type: "note", id: note.id }, [source.name, survivor.name])
    const current = await openStore({ path })
    try {
      const vocabulary = await current.knowledge.vocabulary()
      const options = {
        sourceId: String(source.id),
        survivorId: String(survivor.id),
        expectedVocabularyFingerprint: vocabulary.fingerprint,
      }
      const preview = await current.knowledge.previewTagConsolidation(options)
      const apply = {
        ...options,
        by: "owner" as const,
        expectedPreviewFingerprint: preview.previewFingerprint,
        idempotencyKey: "smoke-reviewed-merge",
      }
      const receipt = await current.knowledge.applyTagConsolidation(apply)
      assert.deepEqual(await current.knowledge.applyTagConsolidation(apply), receipt)
      assert.deepEqual(await current.knowledge.tags(null, { type: "note", id: note.id }), [survivor.name])
      assert.equal((await current.knowledge.resolveVocabulary(source.name)).matches[0]?.id, String(survivor.id))
      await assert.rejects(legacy.knowledge.addTags(null, { type: "note", id: note.id }, [source.name]))
      await assert.rejects(openLegacyStore({ path }), { code: "configuration_error" })
    } finally {
      await current.close()
    }
  } finally {
    await legacy.close()
  }
}
