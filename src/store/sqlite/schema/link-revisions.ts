import { check, index, integer, sql, sqliteTable, text } from "../drizzle/core.js"

export const linkRevisions = sqliteTable(
  "link_revisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    linkId: integer("link_id").notNull(),
    change: text("change").notNull(),
    before: text("before"),
    after: text("after"),
    author: text("author"),
    accountId: integer("account_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("link_revisions_by_link_id_created_at").on(table.linkId, table.createdAt),
    check("link_revisions_before_json", sql`"before" IS NULL OR json_valid("before")`),
  ],
)
