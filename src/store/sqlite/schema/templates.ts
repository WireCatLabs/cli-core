import { index, integer, primaryKey, sqliteTable, text } from "../drizzle/core.js"

/** A template the owner saved over the shipped one, per key, channel and language. */
export const templates = sqliteTable(
  "templates",
  {
    key: text("key").notNull(),
    channel: text("channel").notNull(),
    language: text("language").notNull(),
    body: text("body").notNull(),
    updatedAt: integer("updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [primaryKey({ columns: [table.key, table.channel, table.language] })],
)

/** Every body a save or a reset replaced. */
export const templatesHistory = sqliteTable(
  "templates_history",
  {
    id: integer("id").primaryKey(),
    key: text("key").notNull(),
    channel: text("channel").notNull(),
    language: text("language").notNull(),
    body: text("body").notNull(),
    savedAt: integer("saved_at").notNull(),
    savedBy: text("saved_by").notNull(),
    replacedAt: integer("replaced_at").notNull(),
  },
  (table) => [
    index("templates_history_by_key_channel_language_id").on(table.key, table.channel, table.language, table.id),
  ],
)
