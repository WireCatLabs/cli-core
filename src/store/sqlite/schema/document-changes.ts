import { index, integer, sqliteTable, text } from "../drizzle/core.js"

export const documentChanges = sqliteTable(
  "document_changes",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id").notNull(),
    documentId: integer("document_id").notNull(),
    path: text("path").notNull(),
    title: text("title"),
    event: text("event").notNull(),
    revision: integer("revision").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [index("document_changes_by_account_id_at").on(table.accountId, table.at)],
)
