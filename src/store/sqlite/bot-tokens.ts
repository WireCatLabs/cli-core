import type { Message } from "../../domain/models.js"
import type { SqlValue } from "../driver.js"
import { NORMALIZER_VERSION, normalize } from "../normalize.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"
import { purgeVectorsOf } from "./vectors.js"

// Only a digit may not come before: `bot<id>:<secret>` in an API URL is the shape pasted most often.
const BOT_TOKEN = /(?<!\d)(\d{6,12}):[A-Za-z0-9_-]{30,40}(?![A-Za-z0-9_-])/g
const MAY_HOLD = "*[0-9][0-9][0-9][0-9][0-9][0-9]:*"
const MASKED_THROUGH = "bot_tokens_masked_through"

/** A messenger bot's token keeps the bot's id, which is public, and loses its secret half. */
export const withoutBotTokens = (text: string): string => text.replace(BOT_TOKEN, "$1:<bot token hidden>")

export const withoutBotTokensIn = (message: Message): Message => {
  const { replyTo } = message
  return {
    ...message,
    text: withoutBotTokens(message.text),
    ...(replyTo ? { replyTo: { ...replyTo, text: withoutBotTokens(replyTo.text) } } : {}),
  }
}

/**
 * Masks the tokens in messages this build did not write: those stored before it, and those an older build saves
 * later. On every open, from the newest message checked last time; a store with nothing new costs two index probes.
 * The scan reads outside a write, so the first one, over the whole archive, does not hold other writers back.
 */
export const maskStoredBotTokens = (context: StoreContext): number => {
  const { database, now } = context
  const through = Number(
    database.prepare("SELECT value FROM store_settings WHERE key = ?").get(MASKED_THROUGH)?.value ?? 0,
  )
  const newest = Number(database.prepare("SELECT max(id) AS id FROM messages").get()?.id ?? 0)
  if (newest <= through) return 0
  const messages = database
    .prepare("SELECT id, text, reply_to FROM messages WHERE id > ? AND id <= ? AND (text GLOB ? OR reply_to GLOB ?)")
    .all(through, newest, MAY_HOLD, MAY_HOLD)
    .filter((row) => masks(row.text) || masks(row.reply_to))
  const revisions = database
    .prepare("SELECT id, text FROM message_revisions WHERE message_id > ? AND message_id <= ? AND text GLOB ?")
    .all(through, newest, MAY_HOLD)
    .filter((row) => masks(row.text))
  write(database, () => {
    // Only the text read above: a message another process changed since then was written by a build that masks.
    const message = database.prepare(
      `UPDATE messages SET text = ?, normalized_text = ?, normalizer_version = ?, reply_to = ?
        WHERE id = ? AND text = ? AND reply_to IS ?`,
    )
    for (const row of messages) {
      const text = withoutBotTokens(String(row.text))
      const quote = row.reply_to == null ? null : withoutBotTokens(String(row.reply_to))
      const { changes } = message.run(
        text,
        normalize(text),
        NORMALIZER_VERSION,
        quote,
        Number(row.id),
        row.text as SqlValue,
        row.reply_to as SqlValue,
      )
      if (Number(changes) > 0) purgeVectorsOf(context, Number(row.id))
    }
    const revision = database.prepare("UPDATE message_revisions SET text = ? WHERE id = ? AND text = ?")
    for (const row of revisions) revision.run(withoutBotTokens(String(row.text)), Number(row.id), row.text as SqlValue)
    database
      .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
      .run(MASKED_THROUGH, String(newest), now())
  })
  return messages.length + revisions.length
}

const masks = (value: unknown): boolean => value != null && withoutBotTokens(String(value)) !== value
