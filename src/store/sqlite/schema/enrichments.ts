import { integer, primaryKey, sqliteTable, text } from "../drizzle/core.js"

/** What a hosted model wrote about one record, read by search beside it; only with the owner's consent. */
export const enrichments = sqliteTable(
  "enrichments",
  {
    subjectType: text("subject_type").notNull(),
    subjectId: integer("subject_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    text: text("text").notNull(),
    tokens: integer("tokens").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.subjectType, table.subjectId] })],
)
