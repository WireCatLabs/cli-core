import { index, integer, sql, sqliteTable, text, uniqueIndex } from "../drizzle/core.js"

export const links = sqliteTable(
  "links",
  {
    id: integer("id").primaryKey(),
    fromType: text("from_type").notNull(),
    fromId: integer("from_id").notNull(),
    toType: text("to_type"),
    toId: integer("to_id"),
    kind: text("kind").notNull(),
    anchor: text("anchor"),
    source: text("source").notNull(),
    targetText: text("target_text"),
    targetFolded: text("target_folded"),
    role: text("role"),
    evidence: text("evidence"),
    metadata: text("metadata"),
    confirmed: integer("confirmed").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    author: text("author"),
    updatedAt: integer("updated_at").notNull(),
    purpose: text("purpose"),
    accountId: integer("account_id"),
    startsAt: integer("starts_at"),
    endsAt: integer("ends_at"),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("links_unresolved").on(table.targetFolded).where(sql`to_id IS NULL`),
    uniqueIndex("links_relationship_key")
      .on(
        table.kind,
        table.fromType,
        table.fromId,
        table.toType,
        table.toId,
        sql`ifnull(${table.anchor}, '')`,
        sql`ifnull(${table.role}, '')`,
        sql`ifnull(${table.accountId}, 0)`,
      )
      .where(sql`kind IN ('member-of', 'related-to', 'reports-to', 'customer-of', 'partner-of') AND to_id IS NOT NULL`),
    index("links_by_from_type_from_id").on(table.fromType, table.fromId),
    index("links_by_to_type_to_id").on(table.toType, table.toId),
  ],
)
