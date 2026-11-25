import { index, integer, sqliteTable, text } from "../drizzle/core.js"

export const senderBots = sqliteTable("sender_bots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  personId: integer("person_id").notNull().unique(),
  name: text("name"),
  organizationId: integer("organization_id"),
  author: text("author").notNull(),
  reason: text("reason"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

export const senderBotIdentities = sqliteTable(
  "sender_bot_identities",
  {
    identityId: integer("identity_id").primaryKey(),
    botId: integer("bot_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("sender_bot_identities_by_bot_id").on(table.botId)],
)

export const senderBotMoves = sqliteTable(
  "sender_bot_moves",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    identityId: integer("identity_id").notNull(),
    fromPersonId: integer("from_person_id"),
    fromBotId: integer("from_bot_id"),
    toPersonId: integer("to_person_id"),
    toBotId: integer("to_bot_id"),
    author: text("author").notNull(),
    reason: text("reason"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("sender_bot_moves_by_identity_id").on(table.identityId),
    index("sender_bot_moves_by_from_person_id").on(table.fromPersonId),
  ],
)
