import { index, integer, sqliteTable, text } from "../drizzle/core.js"
import { canonicalTags } from "./canonical-tags.js"

export const tagRedirects = sqliteTable(
  "tag_redirects",
  {
    sourceId: integer("source_id")
      .primaryKey()
      .references(() => canonicalTags.id),
    survivorId: integer("survivor_id")
      .notNull()
      .references(() => canonicalTags.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("tag_redirects_by_survivor_id").on(table.survivorId)],
)

export const tagConsolidations = sqliteTable(
  "tag_consolidations",
  {
    id: integer("id").primaryKey(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => canonicalTags.id),
    survivorId: integer("survivor_id")
      .notNull()
      .references(() => canonicalTags.id),
    sourceMemberIds: text("source_member_ids").notNull(),
    survivorMemberIds: text("survivor_member_ids").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: integer("actor_id").notNull(),
    createdAt: integer("created_at").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    vocabularyFingerprint: text("vocabulary_fingerprint").notNull(),
    previewFingerprint: text("preview_fingerprint").notNull(),
    counts: text("counts").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
  },
  (table) => [
    index("tag_consolidations_by_source_id").on(table.sourceId),
    index("tag_consolidations_by_survivor_id").on(table.survivorId),
    index("tag_consolidations_by_actor_type_actor_id").on(table.actorType, table.actorId),
  ],
)
