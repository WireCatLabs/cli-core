import { integer, primaryKey, sqliteTable, text } from "../drizzle/core.js"

export const documentAnnotationTransfers = sqliteTable(
  "document_annotation_transfers",
  {
    sourceKey: text("source_key").notNull(),
    collection: text("collection").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    bindingsHash: text("bindings_hash").notNull(),
    referenceMap: text("reference_map").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.sourceKey, table.collection] })],
)
