import { integer, sqliteTable, text } from "../drizzle/core.js"

export const canonicalTags = sqliteTable("canonical_tags", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().unique(),
  kind: text("kind").notNull().default("tag"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})
