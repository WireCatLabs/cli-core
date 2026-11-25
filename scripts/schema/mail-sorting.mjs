import { c, id, ts } from "./columns.mjs"

const mailSortRulesTable = {
  name: "mail_sort_rules",
  doc: "A sorting rule over mail, the owner's or the program's: what one mail, a List-Id, a subject pattern, an address or a registrable domain is. Every owner's rule comes before every program's; within one author the first scope that matches wins in that order, and within a scope the newest; then the header classifier. Not `mail_rules`, which decides how one account's sync stores mail.",
  cols: [
    id(),
    c("scope", "text", { notnull: true, note: "`mail`, `list`, `subject`, `address` or `domain`" }),
    c("value", "text", {
      notnull: true,
      note: "the email's id, the List-Id, the folded subject pattern, the lower-case address or the registrable domain",
    }),
    c("mail_type", "text", { note: "the type it gives each mail it matches; null leaves the type to the classifier" }),
    c("sender", "text", {
      note: "`bot` or `person`: what the sender becomes, for its whole history; the owner's only",
    }),
    c("organization_id", "integer", {
      note: "the organization the sender's addresses are filed under; no foreign key, a gone one files nothing",
    }),
    c("over_addresses", "integer", {
      notnull: true,
      note: "1: this domain rule beats the address rules at its domain",
    }),
    c("past", "integer", { notnull: true, note: "1: past mail too; 0: only mail dated from `created_at` on" }),
    c("author", "text", { notnull: true, note: "`owner` or `program`" }),
    c("decided_by", "text", { note: "the bot that made a program's rule" }),
    c("reason", "text", { note: "why, in the owner's or the program's words" }),
    ...ts(),
    c("removed_at", "integer", { note: "removed; kept so the removal can be undone" }),
    c("undone_at", "integer", {
      note: "its add was undone; the next undo goes further back",
    }),
  ],
  keys: ["INDEX (scope, value)"],
}

const mailSortEffectsTable = {
  name: "mail_sort_effects",
  doc: "What a sorting rule did to one sender identity beyond its mail types: the sender moved to a bot or a person, or its address filed under an organization. A removal of the rule puts back `before`, author included, unless the sender moved since. A trigger drops an identity's rows with it.",
  cols: [
    id(),
    c("rule_id", "integer", { notnull: true, note: "the `mail_sort_rules` row" }),
    c("identity_id", "integer", {
      notnull: true,
      note: "no foreign key, as the bot tables: an older build purging an account does not know this table",
    }),
    c("action", "text", { notnull: true, note: "`sender` or `organization`" }),
    c("before", "text", {
      note: "`person:<id>` or `bot:<id>` (`sender-bot:<id>` before store version 78) it was held by, then who put it there: `bot:4 rules`, `person:9 owner`; for `organization`, `held` when it already was",
    }),
    c("after", "text", { note: "where the rule put it; equal to `before` when the rule left it, as for past senders" }),
    c("created_at", "integer", { notnull: true }),
    c("undone_at", "integer", { note: "put back when the rule was removed" }),
  ],
  keys: ["INDEX (rule_id)", "INDEX (identity_id)"],
}

export const mailSortingTables = [mailSortRulesTable, mailSortEffectsTable]
