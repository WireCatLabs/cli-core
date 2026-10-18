import { CliError, isCliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import type { Id, Message } from "../../domain/models.js"
import type { MarkedRead } from "../../services/chats.js"
import type { Services } from "../../services/index.js"
import { environmentOf } from "../context.js"
import type { Settings } from "../settings.js"

export const MARK_READ_OPTION = [
  "--mark-read",
  "also mark each chat shown read, up to the newest message shown; the other side sees it",
] as const
export const NO_MARK_READ_OPTION = ["--no-mark-read", "do not, whatever the catch_up_marks_read setting says"] as const
// Neither is offered to an agent (`ownerOnlyOption`): a read tool may run unasked, and the other side sees a mark.
// An agent marks read with `chats mark-read`, a write.

/**
 * The typed flag decides; without one, the owner's `catch_up_marks_read` setting, off unless turned on (NEED-566).
 * An agent's run never marks read on that setting: the other side sees it, so only an agent that asks does.
 */
export const marksRead = (typed: boolean | undefined, settings: Settings, command: Command): boolean => {
  const marking = typed ?? (environmentOf(command).agent ? false : settings.catchUpMarksRead)
  if (marking && settings.offline) {
    throw new CliError("validation_error", "--mark-read tells the messenger; not with --offline")
  }
  return marking
}

/** Whose `--new` points a run moves: an agent's are its own, so the owner's `inbox --new` still shows everything. */
export const pointsOf = <N extends "inbox" | "review">(command: Command, name: N): N | `mcp-${N}` =>
  environmentOf(command).agent ? `mcp-${name}` : name

/**
 * Marks each chat read up to the newest message shown in it — never further, so what arrived after
 * the read stays unread. Through the send guard, so `permissions.chats.mark-read` applies.
 */
export const markShown = async (
  services: Services,
  chats: { id: Id; messages: Pick<Message, "id" | "timestamp">[] }[],
  warn: (message: string) => void,
): Promise<MarkedRead[]> => {
  const marked: MarkedRead[] = []
  for (const { id, messages } of chats) {
    const newest = messages.reduce<Pick<Message, "id" | "timestamp"> | undefined>(
      (last, one) => (last === undefined || Date.parse(one.timestamp) >= Date.parse(last.timestamp) ? one : last),
      undefined,
    )
    if (newest === undefined) continue
    try {
      const { chatId, until } = await services.chats.markRead({ chat: id, until: newest.id })
      marked.push({ chatId, until })
    } catch (error) {
      // A hold refuses every chat alike; what was read is still the answer, as reads go on during one.
      if (!isCliError(error) || error.details.sendBlock === undefined) throw error
      warn(`${error.message}; nothing more was marked read`)
      break
    }
  }
  return marked
}
