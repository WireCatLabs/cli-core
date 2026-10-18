import { type DownloadedFile, matchDownloads, type PlacedFile, type RefreshedFile } from "../../domain/attachments.js"
import type { Id, ProviderMetadata } from "../../domain/models.js"
import { and, eq } from "./drizzle/core.js"
import { folded } from "./folded.js"
import type { StoreContext } from "./open.js"
import { attachments, messages } from "./schema.js"

const refColumn = (ref: ProviderMetadata | undefined) =>
  ref && Object.keys(ref).length > 0 ? { providerRef: JSON.stringify(ref) } : {}

/** Sets `change` on the stored attachment each file is, where `matchDownloads` names it; answers how many it set. */
const updatePlaced = <F extends PlacedFile>(
  { orm }: StoreContext,
  chatKey: number,
  messageId: Id,
  files: readonly F[],
  change: (file: F) => Partial<typeof attachments.$inferInsert>,
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
      .set(change(file))
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

/**
 * Records where each saved file went, and a new reference the messenger gave for it; answers how many attachments
 * it could name with certainty.
 */
export const keepDownloads = (
  context: StoreContext,
  chatKey: number,
  messageId: Id,
  files: readonly DownloadedFile[],
): number =>
  updatePlaced(context, chatKey, messageId, files, (file) => ({
    localPath: file.path,
    localPathFolded: folded(file.path),
    ...refColumn(file.providerRef),
  }))

/** The new reference of files read without saving them; a saved path stays. Answers how many it could place. */
export const keepProviderRefs = (
  context: StoreContext,
  chatKey: number,
  messageId: Id,
  files: readonly RefreshedFile[],
): number =>
  updatePlaced(
    context,
    chatKey,
    messageId,
    files.filter((file) => Object.keys(file.providerRef).length > 0),
    (file) => refColumn(file.providerRef),
  )
