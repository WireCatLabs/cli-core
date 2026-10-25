import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type {
  TagConsolidationApplyOptions,
  TagConsolidationOptions,
  TagConsolidationPreview,
  TagConsolidationReceipt,
} from "../../domain/tag-consolidation.js"
import { createTagRedirectIndex } from "../../domain/tag-redirects.js"
import { ownerPerson } from "./actors.js"
import type { StoreContext } from "./open.js"
import { consolidationApplyInput } from "./tag-consolidation-input.js"
import { tagRedirectSnapshot } from "./tag-resolution.js"
import { write } from "./transaction.js"

type Row = Record<string, unknown>
const receiptOf = (row: Row): TagConsolidationReceipt => ({
  id: String(row.id),
  sourceId: String(row.source_id),
  survivorId: String(row.survivor_id),
  sourceMemberIds: JSON.parse(String(row.source_member_ids)) as string[],
  survivorMemberIds: JSON.parse(String(row.survivor_member_ids)) as string[],
  actor: { type: "person", id: String(row.actor_id) },
  createdAt: new Date(Number(row.created_at)).toISOString(),
  idempotencyKey: String(row.idempotency_key),
  vocabularyFingerprint: String(row.vocabulary_fingerprint),
  previewFingerprint: String(row.preview_fingerprint),
  counts: JSON.parse(String(row.counts)) as TagConsolidationReceipt["counts"],
})

export const applyTagConsolidation = (
  context: StoreContext,
  preview: (options: TagConsolidationOptions) => TagConsolidationPreview,
  options: TagConsolidationApplyOptions,
): TagConsolidationReceipt => {
  const { source, survivor, maxRows, maxReadBytes } = consolidationApplyInput(options)
  const { database, now } = context
  const check = () => {
    if (options.signal?.aborted) throw new CliError("cancelled", "tag consolidation was cancelled")
  }
  check()
  return write(
    database,
    () => {
      const owner = ownerPerson(database)
      const request = createHash("sha256")
        .update(
          JSON.stringify([
            source,
            survivor,
            owner.type,
            owner.id,
            options.expectedVocabularyFingerprint,
            options.expectedPreviewFingerprint,
          ]),
        )
        .digest("hex")
      const held = database
        .prepare("SELECT * FROM tag_consolidations WHERE idempotency_key=?")
        .get(options.idempotencyKey)
      if (held) {
        if (held.request_fingerprint !== request)
          throw new CliError("configuration_error", "idempotencyKey already records another reviewed tag consolidation")
        return receiptOf(held)
      }
      const selected = preview({
        sourceId: options.sourceId,
        survivorId: options.survivorId,
        expectedVocabularyFingerprint: options.expectedVocabularyFingerprint,
        maxRows,
        maxReadBytes,
        sampleLimit: 1,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (selected.previewFingerprint !== options.expectedPreviewFingerprint)
        throw new CliError("configuration_error", "tag dependencies changed since the consolidation preview", {
          reason: "vocabulary.stale",
        })
      const graph = tagRedirectSnapshot(database)
      createTagRedirectIndex({
        ...graph,
        redirects: [
          ...graph.redirects.map((row) =>
            row.survivorId === String(source) ? { ...row, survivorId: String(survivor) } : row,
          ),
          { sourceId: String(source), survivorId: String(survivor) },
        ],
      })
      const at = now()
      const counts: TagConsolidationReceipt["counts"] = {
        assignments: selected.assignments.source + selected.assignments.survivor,
        aliases: selected.aliases.source + selected.aliases.survivor,
        automaticClaims: selected.automaticClaims.source + selected.automaticClaims.survivor,
        links: selected.links.total,
      }
      check()
      database.prepare("UPDATE tag_redirects SET survivor_id=? WHERE survivor_id=?").run(survivor, source)
      database
        .prepare("INSERT INTO tag_redirects(source_id,survivor_id,created_at) VALUES(?,?,?)")
        .run(source, survivor, at)
      tagRedirectSnapshot(database)
      const row = database
        .prepare(
          "INSERT INTO tag_consolidations(source_id,survivor_id,source_member_ids,survivor_member_ids,actor_type,actor_id,created_at,idempotency_key,vocabulary_fingerprint,preview_fingerprint,counts,request_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *",
        )
        .get(
          source,
          survivor,
          JSON.stringify(selected.sourceMemberIds),
          JSON.stringify(selected.survivorMemberIds),
          owner.type,
          owner.id,
          at,
          options.idempotencyKey,
          selected.vocabularyFingerprint,
          selected.previewFingerprint,
          JSON.stringify(counts),
          request,
        )
      return receiptOf(row as Row)
    },
    { beforeCommit: check },
  )
}
