import { integer, primaryKey, sqliteTable, text } from "../drizzle/core.js"

export const documentIndexPending = sqliteTable(
  "document_index_pending",
  {
    id: integer("id").notNull(),
    indexableType: text("indexable_type").notNull(),
  },
  (table) => [primaryKey({ columns: [table.indexableType, table.id] })],
)
