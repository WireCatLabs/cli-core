import type { CacheDatabase } from "../driver.js"
import { dropAttachmentChunks } from "./email-index.js"
import { flag } from "./events.js"
import { dropUnusedVectors } from "./vector-index.js"

export const recountEmailThread = (database: CacheDatabase, threadId: number, now: number) =>
  database
    .prepare(
      `UPDATE email_threads SET
         emails_count = (SELECT count(*) FROM emails WHERE email_thread_id = ? AND deleted_at IS NULL),
         last_email_at = (SELECT max(coalesce(sent_at, received_at)) FROM emails
           WHERE email_thread_id = ? AND deleted_at IS NULL),
         deleted_at = CASE
           WHEN EXISTS (SELECT 1 FROM emails WHERE email_thread_id = ? AND deleted_at IS NULL) THEN NULL
           WHEN EXISTS (SELECT 1 FROM emails WHERE email_thread_id = ?) THEN coalesce(deleted_at, ?)
           ELSE deleted_at END,
         updated_at = ?
       WHERE id = ?`,
    )
    .run(threadId, threadId, threadId, threadId, now, now, threadId)

export const setEmailFlags = (
  database: CacheDatabase,
  accountId: number,
  flags: ReadonlyMap<string, { read?: boolean; flagged?: boolean }>,
  now: number,
): number => {
  const update = database.prepare(
    `UPDATE emails SET read = CASE WHEN ? IS NULL THEN read ELSE ? END,
       flagged = CASE WHEN ? IS NULL THEN flagged ELSE ? END, updated_at = ?
     WHERE account_id = ? AND external_id = ?
       AND ((? IS NOT NULL AND read IS NOT ?) OR (? IS NOT NULL AND flagged IS NOT ?))`,
  )
  let changed = 0
  for (const [externalId, { read, flagged }] of flags) {
    const readValue = flag(read),
      flaggedValue = flag(flagged)
    changed += update.run(
      readValue,
      readValue,
      flaggedValue,
      flaggedValue,
      now,
      accountId,
      externalId,
      readValue,
      readValue,
      flaggedValue,
      flaggedValue,
    ).changes
  }
  return changed
}

export const markEmailsDeleted = (
  database: CacheDatabase,
  accountId: number,
  externalIds: string[],
  now: number,
): number => {
  const mark = database.prepare(
    `UPDATE emails SET deleted_at = ?, body_text = NULL, body_html = NULL, snippet = NULL, updated_at = ?
       WHERE account_id = ? AND external_id = ? AND deleted_at IS NULL
       RETURNING id, email_thread_id`,
  )
  const forget = database.prepare(
    "UPDATE attachments SET text = NULL, normalized_text = NULL WHERE attachable_type = 'email' AND attachable_id = ?",
  )
  const unlocate = database.prepare("DELETE FROM email_locations WHERE email_id = ?")
  const threads = externalIds.flatMap((id) =>
    mark.all(now, now, accountId, id).map((r) => {
      const pieces = dropAttachmentChunks(database, Number(r.id))
      forget.run(Number(r.id))
      unlocate.run(Number(r.id))
      dropUnusedVectors(database, pieces)
      return Number(r.email_thread_id)
    }),
  )
  for (const id of new Set(threads)) recountEmailThread(database, id, now)
  return threads.length
}

export const markEmailsRestored = (
  database: CacheDatabase,
  accountId: number,
  externalIds: string[],
  now: number,
): number => {
  const unmark = database.prepare(
    `UPDATE emails SET deleted_at = NULL, updated_at = ?
       WHERE account_id = ? AND external_id = ? AND deleted_at IS NOT NULL
       RETURNING email_thread_id`,
  )
  const threads = externalIds.flatMap((id) => unmark.all(now, accountId, id).map((r) => Number(r.email_thread_id)))
  for (const id of new Set(threads)) recountEmailThread(database, id, now)
  return threads.length
}
