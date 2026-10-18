import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { itemOf, listOf } from "../../cli/envelope.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { COMMENTS_QUERY, cursorOf, historyQuery, historyWindow } from "../../cli/messenger/history-query.js"
import { evidenceAnswer, threadAnswer } from "../../cli/messenger/message-answers.js"
import { messageItems, type ReadMessage, selfOf } from "../../cli/messenger/message-items.js"
import { isLocator, parseLocator } from "../../domain/locator.js"
import { capability } from "../../ports/messenger.js"
import { readEvidencePacket, readMail } from "../../services/index.js"
import { heard, hearForTool, hearingMissing, modelWith } from "../../speech/hearing.js"
import type { AccountKey } from "../../store/store.js"
import { searchServices } from "../search-sync.js"
import { threadArgs, threadInputs } from "../thread-options.js"
import { type AnyTool, chatOf, limit, message, nameOf, READ, tool } from "../tool.js"
import { answerMessagesStats, messagesStatsDescription, messagesStatsInput } from "./search.js"

const windowOf = (found: ReadMessage[], reader: AccountKey, window: { before: number; after: number }) =>
  listOf("messages context", {
    items: messageItems(found, reader),
    limit: window.before + window.after + 1,
    has_more: false,
  })

/** Mail lives in the store's mail tables, whichever messenger serves the tool. */
const isMail = (chat: string, message: string | undefined) =>
  message === undefined && isLocator(chat) && parseLocator(chat).provider === "email"

export const messagesTools = (messenger: Messenger): Record<string, AnyTool> => {
  const tools = messageTools(messenger)
  if (messenger.scheduledSends === false) delete tools.messages_scheduled
  return tools
}

const messageTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const name = nameOf(messenger)
  return {
    messages_evidence: tool({
      title: "Prepare stored chat evidence",
      description:
        "A chat evidence packet from the current profile's local archive, newest first. Never connects or marks " +
        "read. Whole messages fill at most 64 KiB of JSON items; the packet envelope is additional. Returns " +
        "the packet as item: source locators, fingerprints and coverage (history unknown). When older messages " +
        "exist, next has page.next: pass its cursor. An oversized first message returns an empty, byte-truncated " +
        "packet with no next step; handle that obstruction explicitly. Prepares evidence, not a generated summary.",
      input: v.object({
        chat,
        limit,
        cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.description("page.next's cursor"))),
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const limit = args.limit ?? defaults.limit
        const packet = await readEvidencePacket(
          store,
          account,
          { chat: args.chat, limit, ...(args.cursor === undefined ? {} : { before: args.cursor }) },
          messenger,
        )
        return evidenceAnswer(packet, args.chat, limit)
      },
    }),

    messages_list: tool({
      title: "Read a chat",
      description:
        "Recent messages in a chat, oldest first. Does not mark anything read. `query` says where to start and " +
        "which topic, all terms together: id<42 or date<2h reads back, id>42 or date>2026-10-01 forward, " +
        "topic:12 one forum topic" +
        (messenger.messageStars === true ? ", starred:true only the ones the owner starred" : "") +
        ". When more exist, next has page.next: pass its cursor. A voice message carries " +
        "`transcript` once heard; `transcribe` hears the rest.",
      input: v.object({
        chat,
        query: v.optional(v.pipe(v.string(), v.description("id<42, date>2026-10-01, topic:12"))),
        cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.description("page.next's cursor"))),
        limit,
        transcribe: v.optional(
          v.pipe(v.boolean(), v.description("turn voice messages not heard yet into text; can take minutes")),
        ),
        model: v.optional(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.description("which downloaded speech model hears them, with transcribe"),
          ),
        ),
      }),
      annotations: READ,
      output: { entity: "message", list: true },
      served: async (services, args, defaults, connect) => {
        const size = args.limit ?? defaults.limit
        const window = historyWindow(
          args.query,
          args.cursor,
          "messages list",
          historyQuery({ messageStars: messenger.messageStars === true }),
        )
        const found = await services.messages.list(args.chat, { limit: size, ...window })
        const hearing = await hearForTool(
          messenger,
          connect,
          found.items,
          args.transcribe === true,
          defaults,
          modelWith(args.transcribe, args.model),
        )
        const cursor = found.hasMore
          ? cursorOf(window, { first: found.items[0]?.id, last: found.items.at(-1)?.id })
          : undefined
        return listOf("messages list", {
          items: messageItems(heard(found.items, hearing), await services.messages.reader()),
          limit: size,
          has_more: found.hasMore,
          paging: "cursor",
          ...(cursor === undefined ? {} : { cursor }),
          args: { chat: args.chat, ...(args.query === undefined ? {} : { query: args.query }) },
          missing: hearingMissing(hearing, args.transcribe === true),
        })
      },
    }),

    messages_comments: tool({
      title: "Comments under a channel post",
      description:
        "The comments under one channel post, oldest to newest, read from the messenger. They live in the " +
        "channel's discussion group, which each item's chat_id names. `query` id<42 reads back from a comment; " +
        "page.next's cursor goes on. A post that takes no comments is not_found. Does not mark read.",
      input: v.object({
        chat,
        post: v.pipe(message, v.description("the post's message id in the channel")),
        query: v.optional(v.pipe(v.string(), v.description("id<42"))),
        cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.description("page.next's cursor"))),
        limit,
      }),
      annotations: READ,
      output: { entity: "message", list: true },
      served: async (services, args, defaults) => {
        const size = args.limit ?? defaults.limit
        const window = historyWindow(args.query, args.cursor, "messages comments", COMMENTS_QUERY)
        const found = await services.messages.comments(args.chat, args.post, {
          limit: size,
          ...(window.before === undefined ? {} : { before: window.before }),
        })
        const cursor = found.hasMore ? cursorOf(window, { first: found.items[0]?.id }) : undefined
        return listOf("messages comments", {
          items: messageItems(found.items, await services.messages.reader()),
          limit: size,
          has_more: found.hasMore,
          paging: "cursor",
          ...(cursor === undefined ? {} : { cursor }),
          args: { chat: args.chat, post: args.post, ...(args.query === undefined ? {} : { query: args.query }) },
        })
      },
    }),

    messages_link: tool({
      title: "Get a message link",
      description:
        "An account-scoped locator (ref) and optional provider permalink, without message content; access describes the link audience, not permission granted to its reader. Does not mark read. A locator can replace chat and message.",
      input: v.object({ chat, message: v.optional(message) }),
      annotations: READ,
      output: { entity: "message_link", list: false },
      served: async (services, args) => {
        const { locator, ...link } = await services.messages.link(args.chat, args.message)
        return itemOf({ ref: locator, ...link })
      },
    }),

    messages_context: tool({
      title: "Show a message",
      description:
        "One message by id, and optionally the messages either side of it, oldest first. The one asked for " +
        "carries anchor: true; `before_n` and `after_n` say how many either side. " +
        "With thread=true, reads the stored parent chain and replies without connecting: returns locator, mode, items, links with provenance/stale labels, chain, stale, stopped and bounds. " +
        "thread_hops (8), thread_messages (50), thread_bytes (65536) and thread_within (1d) bound it; no graph gives a labelled local time fallback. " +
        "A msg: locator in chat needs no message argument; it must belong to the active account. offline=true reads ordinary context from this account's local store without connecting. " +
        "A msg:email/… locator reads the whole email and its thread from the stored mail, with people, labels and thread references.",
      input: v.object({
        ...threadInputs,
        offline: v.optional(v.boolean()),
        chat,
        message: v.optional(message),
        before_n: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))),
        after_n: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))),
      }),
      annotations: READ,
      storedWhen: (args) => {
        if (args.thread || args.offline || isMail(args.chat, args.message)) return true
        if (args.message === undefined && !isLocator(args.chat))
          throw new CliError("validation_error", "give a message id, or a msg: locator")
        return false
      },
      stored: async (store, account, args, defaults) => {
        const window = { before: args.before_n ?? 0, after: args.after_n ?? 0 }
        if (isMail(args.chat, args.message))
          return windowOf(await readMail(store, args.chat, window), parseLocator(args.chat), window)
        const services = searchServices(messenger, store, account, defaults)
        if (!args.thread)
          return windowOf(await services.messages.around(args.chat, args.message, window), account, window)
        return threadAnswer(
          await services.messages.thread(args.chat, args.message, {
            ...threadArgs(args).thread,
            before: args.before_n ?? 5,
            after: args.after_n ?? 5,
            signal: defaults.signal,
          }),
          account,
        )
      },
      served: async (services, args) => {
        if (args.message === undefined && !isLocator(args.chat))
          throw new CliError("validation_error", "give a message id, or a msg: locator")
        const window = { before: args.before_n ?? 0, after: args.after_n ?? 0 }
        return windowOf(
          await services.messages.around(args.chat, args.message, window),
          await services.messages.reader(),
          window,
        )
      },
    }),

    messages_scheduled: tool({
      title: "Messages scheduled in a chat",
      description:
        "Messages waiting to be sent later in a chat, soonest first, each with scheduled_for. Look here after a " +
        `scheduled send ended in outcome_unknown. Cancelling one is done in the ${name} app.`,
      input: v.object({ chat }),
      annotations: READ,
      output: { entity: "message", list: true },
      online: async (adapter, args) => {
        const items = await capability(adapter, "scheduled", "list scheduled messages")(args.chat)
        return listOf("messages scheduled", {
          items: messageItems(items, selfOf(messenger, adapter)),
          limit: Math.max(items.length, 1),
          has_more: false,
        })
      },
    }),

    stats_messages_show: tool({
      title: "Count messages",
      description: messagesStatsDescription(messenger),
      input: messagesStatsInput(messenger),
      annotations: { ...READ, openWorldHint: false },
      output: { entity: "message_counts", list: false },
      stored: (store, account, args, defaults, connect) => {
        const services = searchServices(messenger, store, account, defaults, args.sync_first ? connect : undefined)
        return answerMessagesStats(services.messages, args, defaults, services.searches)
      },
    }),
  }
}
