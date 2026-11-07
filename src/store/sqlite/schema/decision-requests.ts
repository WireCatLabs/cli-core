import { integer, sqliteTable, text } from "../drizzle/core.js"

/** One button of a message that asks the owner to decide a batch; only the token's digest is kept. */
export const decisionRequests = sqliteTable("decision_requests", {
  id: integer("id").primaryKey(),
  tokenDigest: text("token_digest").notNull().unique(),
  proposalId: text("proposal_id").notNull(),
  action: text("action").notNull(),
  batchDigest: text("batch_digest").notNull(),
  channel: text("channel").notNull(),
  botProfile: text("bot_profile").notNull(),
  chatId: text("chat_id").notNull(),
  messageId: text("message_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  cancelledAt: integer("cancelled_at"),
})
