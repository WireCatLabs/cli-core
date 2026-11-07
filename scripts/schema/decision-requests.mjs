import { c, id } from "./columns.mjs"

export const decisionRequestTables = [
  {
    name: "decision_requests",
    doc: "One button of a message that asks the owner to decide a batch. The button carries a random token; only its digest is kept. Using one token cancels the others of its message.",
    cols: [
      id(),
      c("token_digest", "text", {
        notnull: true,
        unique: true,
        note: "SHA-256 of the token, hex; the token itself is never stored",
      }),
      c("proposal_id", "text", { notnull: true, note: "the batch the message is about, as its owner names it" }),
      c("action", "text", { notnull: true, note: "confirm, reject, ask-confirm, ask-reject, back or later" }),
      c("batch_digest", "text", { notnull: true, note: "digest of the batch when the message was sent" }),
      c("channel", "text", { notnull: true, note: "the messenger, such as `telegram`" }),
      c("bot_profile", "text", { notnull: true, note: "the bot that sent the message" }),
      c("chat_id", "text", { notnull: true, note: "the chat the message is in" }),
      c("message_id", "text", { notnull: true, note: "the message the button is on" }),
      c("owner_user_id", "text", { notnull: true, note: "the one user whose press counts" }),
      c("created_at", "integer", { notnull: true }),
      c("expires_at", "integer", { notnull: true, note: "72 hours after creation" }),
      c("used_at", "integer", { note: "set once, by the press that took the token" }),
      c("cancelled_at", "integer", { note: "a sibling was used, or the owner turned the feature off" }),
    ],
    keys: ["INDEX (channel, bot_profile, chat_id, message_id)"],
  },
]
