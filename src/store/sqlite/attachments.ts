import { type DownloadedFile, matchDownloads } from "../../domain/attachments.js"
import type { Id } from "../../domain/models.js"
import { and, eq } from "./drizzle/core.js"
import { folded } from "./folded.js"
import type { StoreContext } from "./open.js"
import { attachments, messages } from "./schema.js"

/** Records where each saved file went; answers how many attachments it could name with certainty. */
export const keepDownloads = (
  { orm }: StoreContext,
  chatKey: number,
  messageId: Id,
  files: readonly DownloadedFile[],
): number => {
  const message = orm
    .select({ pk: messages.id })
    .from(messages)
    .where(and(eq(messages.chatId, chatKey), eq(messages.externalId, messageId)))
    .get()
  if (!message) return 0
  const stored = orm
    .select({ position: attachments.position, kind: attachments.kind, name: attachments.name })
    .from(attachments)
    .where(and(eq(attachments.attachableType, "message"), eq(attachments.attachableId, message.pk)))
    .orderBy(attachments.position)
    .all()
  let kept = 0
  matchDownloads(stored, files).forEach((position, index) => {
    const file = files[index]
    if (position === undefined || !file) return
    orm
      .update(attachments)
      .set({ localPath: file.path, localPathFolded: folded(file.path) })
      .where(
        and(
          and(eq(attachments.attachableType, "message"), eq(attachments.attachableId, message.pk)),
          eq(attachments.position, position),
        ),
      )
      .run()
    kept += 1
  })
  return kept
}
