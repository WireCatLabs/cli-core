import { c, id, ts } from "./columns.mjs"

const senderBotsTable = {
  name: "sender_bots",
  doc: "A program that writes to the owner: a no-reply or alert address, a messenger bot, a service's mail. An entity of its own beside `persons` (`sender-bot:<id>`): it holds its identities in `sender_bot_identities`, never in `identity_links`, so it is never listed or proposed as a person, has no ties and is no task's assignee. Not the `bots` table, which holds agents that work here.",
  cols: [
    id(),
    c("person_id", "integer", {
      notnull: true,
      unique: true,
      note: "kept for builds before version 75, which read a bot as this person row: negative for every bot since, so it names no person. A positive one is a bot such a build sorted after the upgrade, whose identities the next list moves here",
    }),
    c("name", "text", { note: "the owner's name for it; null shows its identities' name" }),
    c("organization_id", "integer", {
      note: "the organization it sends for; no foreign key, a trigger clears it when the organization row goes",
    }),
    c("author", "text", { notnull: true, note: "`rules` or `owner`: the owner's bot never goes back by a rule" }),
    c("reason", "text", { note: "what sorted it: the kind signals, such as `no-reply`, or the owner's words" }),
    ...ts(),
  ],
}

const senderBotIdentitiesTable = {
  name: "sender_bot_identities",
  doc: "The identities a sender bot holds. An identity is here or in `identity_links`, never both: a trigger refuses its link to a person while a bot holds it, so an older build's sync gives it no person again. Its messages and mail keep pointing at the identity.",
  cols: [
    c("identity_id", "integer", {
      pk: true,
      note: "no foreign key, as the other bot tables: an older build purging an account does not know this table, and a trigger drops the row with the identity",
    }),
    c("bot_id", "integer", { notnull: true, note: "the `sender_bots` row; the bot goes when its last identity does" }),
    c("created_at", "integer", { notnull: true, note: "when the bot took it" }),
  ],
  keys: ["INDEX (bot_id)"],
}

const senderBotMovesTable = {
  name: "sender_bot_moves",
  doc: "Every move of an identity between a person and a sender bot, by the rules or by the owner. An identity whose latest move is the owner's is never moved by a rule again. A trigger drops an identity's rows with it.",
  cols: [
    id(),
    c("identity_id", "integer", {
      notnull: true,
      note: "no foreign key: an older build purging an account does not know this table",
    }),
    c("from_person_id", "integer", { note: "the person it left, or null" }),
    c("from_bot_id", "integer", { note: "the sender bot it left, or null" }),
    c("to_person_id", "integer", { note: "the person it went to, or null" }),
    c("to_bot_id", "integer", { note: "the sender bot it went to, or null" }),
    c("author", "text", { notnull: true, note: "`rules` or `owner`" }),
    c("reason", "text", { note: "the kind signals of a rule's move, or the owner's words" }),
    c("created_at", "integer", { notnull: true, note: "when it moved" }),
  ],
  keys: ["INDEX (identity_id)", "INDEX (from_person_id)"],
}

export const senderBotTables = [senderBotsTable, senderBotIdentitiesTable, senderBotMovesTable]
