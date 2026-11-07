import { index, integer, sqliteTable, text } from "../drizzle/core.js"

/** One row per change of a relationship link, written by triggers on `links`. */
export const linkRevisions = sqliteTable(
  "link_revisions",
  {
    id: integer("id").primaryKey(),
    linkId: integer("link_id").notNull(),
    change: text("change").notNull(),
    before: text("before"),
    after: text("after"),
    author: text("author"),
    accountId: integer("account_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("link_revisions_by_link_id_created_at").on(table.linkId, table.createdAt)],
)
