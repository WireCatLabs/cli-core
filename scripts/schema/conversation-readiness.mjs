import { c, fk } from "./columns.mjs"

export const conversationReadinessTables = [
  {
    name: "conversation_readiness",
    doc: "How up to date one built chat's conversations and one model's vectors are, as `search conversations` reports it: counted once and kept until triggers drop the row, when a message of the chat is written, revised or deleted, the chat is built again or a vector of the model is added or removed. Derived: a missing row is counted again.",
    cols: [
      fk("chat_id", "chats", { notnull: true }),
      c("model", "text", { notnull: true, note: "`<provider>:<model>:<dims>`, as in `embeddings`" }),
      c("new_count", "integer", { notnull: true, note: "messages not in the current build" }),
      c("edited_count", "integer", { notnull: true, note: "messages in it revised since the build" }),
      c("deleted_count", "integer", { notnull: true, note: "messages in it deleted since the build" }),
      c("chunks", "integer", { notnull: true, note: "distinct chunk texts of the current build" }),
      c("embedded_count", "integer", { notnull: true, note: "of those, with a vector of the model" }),
      c("current", "integer", { notnull: true, note: "with a vector and no changed message inside" }),
      c("stale", "integer", { notnull: true, note: "holding a message edited or deleted since the build" }),
      c("counted_at", "integer", { notnull: true }),
    ],
    keys: ["PRIMARY KEY (chat_id, model)", "INDEX (model)"],
  },
]
