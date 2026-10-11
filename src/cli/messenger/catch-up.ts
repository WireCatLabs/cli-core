import { CliError } from "@wirecat/cli-base"
import type { Id, Message } from "../../domain/models.js"
import type { MarkedRead } from "../../services/chats.js"
import type { Services } from "../../services/index.js"
import type { Settings } from "../settings.js"

export const MARK_READ_OPTION = [
  "--mark-read",
  "also mark each chat shown read, up to the newest message shown; the other side sees it",
] as const
export const NO_MARK_READ_OPTION = ["--no-mark-read", "do not, whatever the catchUpMarksRead setting says"] as const

/** The typed flag decides; without one, the owner's `catchUpMarksRead` setting, off unless turned on (NEED-566). */
export const marksRead = (typed: boolean | undefined, settings: Settings): boolean => {
  const marking = typed ?? settings.catchUpMarksRead
  if (marking && settings.offline) {
    throw new CliError("validation_error", "--mark-read tells the messenger; not with --offline")
  }
  return marking
}

/**
 * Marks each chat read up to the newest message shown in it — never further, so what arrived after
 * the read stays unread. Through the send guard, so `permissions.chats.mark-read` applies.
 */
export const markShown = async (
  services: Services,
  chats: { id: Id; messages: Pick<Message, "id" | "timestamp">[] }[],
): Promise<MarkedRead[]> => {
  const marked: MarkedRead[] = []
  for (const { id, messages } of chats) {
    const newest = messages.reduce<Pick<Message, "id" | "timestamp"> | undefined>(
      (last, one) => (last === undefined || Date.parse(one.timestamp) >= Date.parse(last.timestamp) ? one : last),
      undefined,
    )
    if (newest === undefined) continue
    const { chatId, until } = await services.chats.markRead({ chat: id, until: newest.id })
    marked.push({ chatId, until })
  }
  return marked
}
