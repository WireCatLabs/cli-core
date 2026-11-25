import { index, integer, sqliteTable, text } from "../drizzle/core.js"

export const mailSortRules = sqliteTable(
  "mail_sort_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scope: text("scope").notNull(),
    value: text("value").notNull(),
    mailType: text("mail_type"),
    sender: text("sender"),
    organizationId: integer("organization_id"),
    overAddresses: integer("over_addresses").notNull(),
    past: integer("past").notNull(),
    author: text("author").notNull(),
    decidedBy: text("decided_by"),
    reason: text("reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    removedAt: integer("removed_at"),
    undoneAt: integer("undone_at"),
  },
  (table) => [index("mail_sort_rules_by_scope_value").on(table.scope, table.value)],
)

export const mailSortEffects = sqliteTable(
  "mail_sort_effects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ruleId: integer("rule_id").notNull(),
    identityId: integer("identity_id").notNull(),
    action: text("action").notNull(),
    before: text("before"),
    after: text("after"),
    createdAt: integer("created_at").notNull(),
    undoneAt: integer("undone_at"),
  },
  (table) => [
    index("mail_sort_effects_by_rule_id").on(table.ruleId),
    index("mail_sort_effects_by_identity_id").on(table.identityId),
  ],
)
