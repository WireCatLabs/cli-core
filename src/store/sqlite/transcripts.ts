import type { Id } from "../../domain/models.js"
import { keepText } from "./attachment-texts.js"
import { and, eq, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { messageTranscripts } from "./schema.js"

export const transcript = ({ orm }: StoreContext, chatKey: number, messageId: Id) =>
  orm
    .select({ text: messageTranscripts.text, source: messageTranscripts.source })
    .from(messageTranscripts)
    .where(and(eq(messageTranscripts.chatId, chatKey), eq(messageTranscripts.messageExternalId, messageId)))
    .get()

export const keepTranscript = (
  context: StoreContext,
  chatKey: number,
  messageId: Id,
  text: string,
  source: string,
): void => {
  const { orm, database, now } = context
  const message = database
    .prepare("SELECT id, deleted_at FROM messages WHERE chat_id=? AND external_id=?")
    .get(chatKey, messageId)
  if (message?.deleted_at != null) return
  orm
    .insert(messageTranscripts)
    .values({
      messageId: message ? Number(message.id) : null,
      chatId: chatKey,
      messageExternalId: messageId,
      text,
      source,
      heardAt: now(),
      createdAt: now(),
      updatedAt: now(),
    })
    .onConflictDoUpdate({
      target: [messageTranscripts.chatId, messageTranscripts.messageExternalId],
      set: {
        text: sql`excluded.text`,
        source: sql`excluded.source`,
        heardAt: sql`excluded.heard_at`,
        updatedAt: sql`excluded.updated_at`,
        messageId: sql`coalesce(excluded.message_id, ${messageTranscripts.messageId})`,
      },
    })
    .run()
  if (message) intoVoiceAttachment(context, Number(message.id))
}

/**
 * The transcript is also the voice attachment's text, so `content:` and the file word index find it.
 * Text an agent wrote stays.
 */
export const intoVoiceAttachment = (context: StoreContext, messagePk: number): void => {
  const row = context.database
    .prepare(
      `SELECT a.id, t.text, t.source FROM message_transcripts t
       JOIN attachments a ON a.attachable_type = 'message' AND a.attachable_id = t.message_id
       WHERE t.message_id = ? AND (a.kind IN ('voice', 'audio') OR a.mime LIKE 'audio/%') ORDER BY a.position LIMIT 1`,
    )
    .get(messagePk)
  if (!row) return
  keepText(context, Number(row.id), { text: String(row.text), origin: "extracted", extractor: `speech:${row.source}` })
}
