import type { DocumentLinkMessage } from "../contracts/document-links-types.js"

export type { DocumentLinkMessage } from "../contracts/document-links-types.js"

import { linkKind } from "./link-kinds.js"
import type { StoreContext } from "./open.js"

/** Newest first. Read from the text, so an edit that removed a link drops it whatever link rows remain. */
export const documentLinkMessages = ({ database }: StoreContext, chatKey: number): DocumentLinkMessage[] => {
  const rows = database
    .prepare(
      "SELECT m.id, m.external_id, m.text, m.sent_at, m.sender_name, " +
        "coalesce(m.sender_chat_external_id, i.external_id) AS sender_id FROM messages m " +
        "LEFT JOIN identities i ON i.id = m.sender_identity_id " +
        "WHERE m.chat_id = ? AND m.deleted_at IS NULL AND (m.text LIKE '%google.com%' OR m.text LIKE '%forms.gle%') " +
        "ORDER BY m.sent_at DESC, m.id DESC",
    )
    .all(chatKey)
  const linked = database.prepare(
    "SELECT json_extract(d.front_matter, '$.fileId') AS file_id, d.title FROM links l " +
      "JOIN documents d ON d.id = l.to_id AND d.deleted_at IS NULL " +
      `WHERE l.from_type = 'message' AND l.from_id = ? AND l.to_type = 'document' AND l.kind = ${linkKind("links-to")}`,
  )
  return rows.map((row) => ({
    messageId: String(row.external_id),
    text: String(row.text),
    sentAt: new Date(Number(row.sent_at)).toISOString(),
    senderId: row.sender_id == null ? null : String(row.sender_id),
    senderName: row.sender_name == null ? null : String(row.sender_name),
    documents: linked
      .all(Number(row.id))
      .filter((one) => one.file_id != null)
      .map((one) => ({ fileId: String(one.file_id), title: one.title == null ? null : String(one.title) })),
  }))
}
