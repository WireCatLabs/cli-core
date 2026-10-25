import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { openStore } from "@wirecat/cli-core/store"
import { openStore as openLegacyStore } from "@wirecat/cli-core-legacy-tags/store"

const path = process.argv[2]
assert.ok(path && !existsSync(path), "supply a new isolated database path")
const legacy = await openLegacyStore({ path })
try {
  const source = await legacy.knowledge.createTag("arrival")
  const survivor = await legacy.knowledge.createTag("welcome")
  const note = await legacy.notes.addNote({ text: "Synthetic minimum-Node tag smoke" })
  const target = { type: "note", id: note.id }
  await legacy.knowledge.addTags(null, target, [source.name, survivor.name])
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
      by: "owner",
      expectedPreviewFingerprint: preview.previewFingerprint,
      idempotencyKey: "minimum-node-reviewed-merge",
    }
    const receipt = await current.knowledge.applyTagConsolidation(apply)
    assert.deepEqual(await current.knowledge.applyTagConsolidation(apply), receipt)
    assert.deepEqual(await current.knowledge.tags(null, target), [survivor.name])
    assert.equal((await current.knowledge.resolveVocabulary(source.name)).matches[0]?.id, String(survivor.id))
    await assert.rejects(legacy.knowledge.addTags(null, target, [source.name]))
    await assert.rejects(openLegacyStore({ path }), { code: "configuration_error" })
    assert.deepEqual(await current.knowledge.tags(null, target), [survivor.name])
    process.stdout.write(
      `${JSON.stringify({ node: process.version, reviewed_tag_apply: true, legacy_refusal: true })}\n`,
    )
  } finally {
    await current.close()
  }
} finally {
  await legacy.close()
}
