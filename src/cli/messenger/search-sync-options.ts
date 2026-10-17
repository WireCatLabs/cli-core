import type { Command } from "commander"
import { parseDuration } from "../../domain/duration.js"
import type { SyncOptions } from "../../services/search-refresh.js"
import { environmentOf } from "../context.js"
import { positiveCount } from "../paging.js"
import { type Messenger, type MessengerContext, refuseLocalWrite } from "./context.js"

/** Whether the messenger answers for older history; one that pushes it (`history: "store"`) has nothing to fetch first. */
export const syncsFirst = (messenger: Pick<Messenger, "history">): boolean => messenger.history !== "store"

export const syncOptions = (command: Command, messenger: Pick<Messenger, "history">): Command => {
  if (!syncsFirst(messenger)) return command
  command.option("--sync-first", "first fetch new messages within the chat, time and message bounds")
  const existing = command.options.find((one) => one.long === "--max-chats")
  if (existing) existing.description = "at most this many chats; 5 with --sync-first, 20 with --catch-up if not given"
  else command.option("--max-chats <n>", "refresh at most this many chats (default: 5)", positiveCount("--max-chats"))
  return command
    .option("--sync-time <duration>", "stop fetching after this long (default: 30s)")
    .option(
      "--max-messages <n>",
      "fetch at most this many messages total (default: 500)",
      positiveCount("--max-messages"),
    )
}

export const syncRequest = (
  command: Command,
  context: MessengerContext,
): { syncFirst?: SyncOptions; signal?: AbortSignal } => {
  const options = command.opts<{ syncFirst?: boolean; maxChats?: number; syncTime?: string; maxMessages?: number }>()
  if (!options.syncFirst) return {}
  let root = command
  while (root.parent) root = root.parent
  refuseLocalWrite(context, root.name(), "messages.sync-first")
  if (command.parent?.parent?.name() === "stats")
    refuseLocalWrite(context, root.name(), `stats.${command.parent?.name()}.${command.name()}.sync-first`)
  return {
    signal: environmentOf(command).signal,
    syncFirst: {
      ...(options.maxChats === undefined ? {} : { maxChats: options.maxChats }),
      ...(options.syncTime === undefined ? {} : { timeMs: parseDuration(options.syncTime, "--sync-time") }),
      ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
      note: (note) => context.renderer.note(note),
    },
  }
}
