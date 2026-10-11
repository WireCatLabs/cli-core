import { CliError } from "@wirecat/cli-core"
import * as v from "valibot"
import { listStart } from "../../cli/messenger/after.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { capability } from "../../cli/messenger/port.js"
import { listed } from "../../cli/paging.js"
import { isLocator, parseLocator } from "../../domain/locator.js"
import { SAVE_NEXT_STEPS } from "../../meetings/index.js"
import { readEvidencePacket, readMail } from "../../services/index.js"
import { heard, hearForTool, modelWith } from "../../speech/hearing.js"
import { searchServices } from "../search-sync.js"
import { threadArgs, threadInputs } from "../thread-options.js"
import { type AnyTool, chatOf, limit, message, nameOf, READ, snakeOf, tool } from "../tool.js"
import { answerMessagesStats, MESSAGES_STATS_DESCRIPTION, messagesStatsInput } from "./search.js"

/** Mail lives in the store's mail tables, whichever messenger serves the tool. */
const isMail = (chat: string, message: string | undefined) =>
  message === undefined && isLocator(chat) && parseLocator(chat).provider === "email"

export const messagesTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const name = nameOf(messenger)
  return {
    messages_evidence: tool({
      title: "Prepare stored chat evidence",
      description:
        "A chat evidence packet from the current profile's local archive, newest first. Never connects or marks " +
        "read. Whole messages fill at most 64 KiB of JSON items; the packet envelope is additional. Returns " +
        "source locators, fingerprints, coverage (history unknown) and nextBeforeId. Pass a non-null cursor as " +
        "before_id for older messages. An oversized first message returns an empty, byte-truncated packet " +
        "with no cursor; handle that obstruction explicitly. Prepares evidence, not a generated summary.",
      input: v.object({
        chat,
        limit,
        before_id: v.optional(v.pipe(message, v.description("only messages older than this message id"))),
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: (store, account, args, defaults) =>
        readEvidencePacket(
          store,
          account,
          {
            chat: args.chat,
            limit: args.limit ?? defaults.limit,
            ...(args.before_id === undefined ? {} : { before: args.before_id }),
          },
          messenger,
        ),
    }),

    messages_list: tool({
      nextSteps: SAVE_NEXT_STEPS,
      title: "Read a chat",
      description:
        "Recent messages in a chat, oldest first. Does not mark anything read. For older messages pass " +
        "`before_id` = the id of the first item, or `before_time`; for newer ones, `after_id` = the id of the last " +
        "item, or `after_time`. One of the four at most. A voice message carries `transcript` once heard; " +
        "`transcribe` hears the rest. Returns { items, page, limit, hasMore }.",
      input: v.object({
        chat,
        limit,
        before_id: v.optional(v.pipe(message, v.description("only messages older than this message id"))),
        before_time: v.optional(
          v.pipe(v.string(), v.description("only messages older than this ISO 8601 time, or 2h / 1d ago")),
        ),
        after_id: v.optional(v.pipe(message, v.description("only messages newer than this message id"))),
        after_time: v.optional(
          v.pipe(v.string(), v.description("only messages newer than this ISO 8601 time, or 2h / 1d ago")),
        ),
        topic: v.optional(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.description("only this forum topic, read back from its newest message or before_id"),
          ),
        ),
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
      served: async (services, args, defaults, connect) => {
        const size = args.limit ?? defaults.limit
        const start = listStart(
          {
            beforeId: args.before_id,
            beforeTime: args.before_time,
            afterId: args.after_id,
            afterTime: args.after_time,
          },
          snakeOf,
        )
        const found = await services.messages.list(args.chat, {
          limit: size,
          ...start,
          ...(args.topic === undefined ? {} : { threadId: args.topic }),
        })
        const hearing = await hearForTool(
          messenger,
          connect,
          found.items,
          args.transcribe === true,
          defaults,
          modelWith(args.transcribe, args.model),
        )
        return {
          items: heard(found.items, hearing),
          page: 1,
          limit: size,
          hasMore: found.hasMore,
          ...(args.transcribe ? { unheard: hearing?.unheard ?? [] } : {}),
          ...(hearing?.problem === undefined ? {} : { transcribeProblem: hearing.problem }),
        }
      },
    }),

    messages_comments: tool({
      title: "Comments under a channel post",
      description:
        "The comments under one channel post, oldest to newest, read from the messenger: { discussion: { chatId, " +
        "messageId }, items, hasMore }. They live in the channel's discussion group; before_id pages back. A post " +
        "that takes no comments is not_found. Does not mark read.",
      input: v.object({
        chat,
        post: v.pipe(message, v.description("the post's message id in the channel")),
        limit,
        before_id: v.optional(v.pipe(message, v.description("only comments older than this one"))),
      }),
      annotations: READ,
      served: async (services, args, defaults) =>
        services.messages.comments(args.chat, args.post, {
          limit: args.limit ?? defaults.limit,
          ...(args.before_id === undefined ? {} : { before: args.before_id }),
        }),
    }),

    messages_link: tool({
      title: "Get a message link",
      description:
        "An account-scoped locator and optional provider permalink, without message content. Returns { locator, url, access, reason }; access describes the link audience, not permission granted to its reader. Does not mark read. A locator can replace chat and message.",
      input: v.object({ chat, message: v.optional(message) }),
      annotations: READ,
      served: async (services, args) => services.messages.link(args.chat, args.message),
    }),

    messages_context: tool({
      nextSteps: SAVE_NEXT_STEPS,
      title: "Show a message",
      description:
        "One message by id, and optionally the messages either side of it, oldest first. The one asked for " +
        "carries anchor: true; `before_n` and `after_n` say how many either side. Returns { items, page, limit, hasMore }. " +
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
        if (isMail(args.chat, args.message))
          return listed(await readMail(store, args.chat, { before: args.before_n ?? 0, after: args.after_n ?? 0 }))
        const services = searchServices(messenger, store, account, defaults)
        if (!args.thread)
          return listed(
            await services.messages.around(args.chat, args.message, {
              before: args.before_n ?? 0,
              after: args.after_n ?? 0,
            }),
          )
        return services.messages.thread(args.chat, args.message, {
          ...threadArgs(args).thread,
          before: args.before_n ?? 5,
          after: args.after_n ?? 5,
          signal: defaults.signal,
        })
      },
      served: async (services, args) => {
        if (args.message === undefined && !isLocator(args.chat))
          throw new CliError("validation_error", "give a message id, or a msg: locator")
        return listed(
          await services.messages.around(args.chat, args.message, {
            before: args.before_n ?? 0,
            after: args.after_n ?? 0,
          }),
        )
      },
    }),

    messages_scheduled: tool({
      title: "Messages scheduled in a chat",
      description:
        "Messages waiting to be sent later in a chat, soonest first, each with scheduledFor. Look here after a " +
        `scheduled send ended in outcome_unknown. Cancelling one is done in the ${name} app. Returns { items }.`,
      input: v.object({ chat }),
      annotations: READ,
      online: async (adapter, args) => ({
        items: await capability(adapter, "scheduled", "list scheduled messages")(args.chat),
      }),
    }),

    stats_messages_show: tool({
      title: "Count messages",
      description: MESSAGES_STATS_DESCRIPTION,
      input: messagesStatsInput(messenger),
      annotations: { ...READ, openWorldHint: false },
      stored: (store, account, args, defaults, connect) => {
        const services = searchServices(messenger, store, account, defaults, args.sync_first ? connect : undefined)
        return answerMessagesStats(services.messages, args, defaults, services.searches)
      },
    }),
  }
}
