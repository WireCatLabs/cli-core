import { c, id, ts } from "./columns.mjs"

const senderBotsTable = {
  name: "sender_bots",
  doc: "A program that writes to the owner: a no-reply or alert address, a messenger bot, a service's mail. Not a person, so it is never proposed as the same person, has no ties and is no task's assignee. Its identities are those of the person row it was sorted from, which `people list` shows as `automated`. Not the `bots` table, which holds agents that work here.",
  cols: [
    id(),
    c("person_id", "integer", {
      notnull: true,
      unique: true,
      note: "the person row whose identities are this bot's; its `person:` uid stays the bot's handle in lists. No foreign key: an older build erasing the person does not know this table, and a trigger drops the bot with it",
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
  keys: ["INDEX (identity_id)"],
}

export const senderBotTables = [senderBotsTable, senderBotMovesTable]
