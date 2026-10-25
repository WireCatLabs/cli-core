import { actor, c, fk, id, poly, ts } from "./columns.mjs"

export const tagConsolidationTables = [
  {
    name: "tag_redirects",
    doc: "A retained plain tag now resolves to another plain tag. Original rows and their attribution remain intact.",
    cols: [
      fk("source_id", "canonical_tags", { pk: true }),
      fk("survivor_id", "canonical_tags", { notnull: true }),
      c("created_at", "integer", { notnull: true }),
    ],
  },
  {
    name: "tag_consolidations",
    doc: "Immutable text-free receipts for owner-reviewed tag consolidation. IDs, hashes and counts cannot restore deleted source content.",
    cols: [
      id(),
      fk("source_id", "canonical_tags", { notnull: true }),
      fk("survivor_id", "canonical_tags", { notnull: true }),
      c("source_member_ids", "text", { notnull: true, note: "JSON array of retained source IDs" }),
      c("survivor_member_ids", "text", { notnull: true, note: "JSON array of retained survivor IDs" }),
      ...actor("actor", { notnull: true }),
      c("created_at", "integer", { notnull: true }),
      c("idempotency_key", "text", { notnull: true, unique: true }),
      c("vocabulary_fingerprint", "text", { notnull: true }),
      c("preview_fingerprint", "text", { notnull: true }),
      c("counts", "text", { notnull: true, note: "JSON counts only; no names, bodies or evidence" }),
      c("request_fingerprint", "text", { notnull: true }),
    ],
  },
]

export const taggingTable = {
  name: "taggings",
  doc: "One tag on one thing.",
  cols: [
    id(),
    fk("tag_id", "canonical_tags", { notnull: true }),
    ...poly(
      "taggable",
      "`chat`, `identity`, `message`, `email`, `document`, `note`, `person`, `organization`, `project`, `task`, `event`, …",
    ),
    c("main", "integer", { notnull: true, note: "1 on the thing's main topic; at most one per thing" }),
    c("source", "text", { notnull: true, note: "where it came from: owner, agent, auto, an import" }),
    ...actor("author"),
    ...ts(),
  ],
  keys: ["UNIQUE (tag_id, taggable_type, taggable_id)", "UNIQUE (taggable_type, taggable_id) WHERE main = 1"],
}
