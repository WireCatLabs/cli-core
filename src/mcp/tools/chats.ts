import * as v from "valibot"
import { registriesCover } from "../../botcheck/registries.js"
import { listOf } from "../../cli/envelope.js"
import { listQuery, queryInput as query } from "../../cli/list-query.js"
import { chatAnswer } from "../../cli/messenger/chat-answers.js"
import { CHATS_QUERY } from "../../cli/messenger/chat-queries.js"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import { listed } from "../../cli/paging.js"
import { casKey } from "../../cli/registry-keys.js"
import type { SendGuard } from "../../sends/guard.js"
import { EVENTS_DAYS, onlineDeps, servicesFor, storedDeps } from "../../services/index.js"
import { momentOf } from "../../services/moment.js"
import { type AnyTool, chatOf, envelope, limit, page, paging, READ, tool } from "../tool.js"

export const chatsTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const chats = (adapter: MessengerAdapter, guard: SendGuard) =>
    servicesFor(onlineDeps(messenger, adapter, guard)).chats
  return {
    chats_list: tool({
      title: "List chats",
      description:
        "Chats the owner is in, most recent first. Use it to find a chat's id before reading or sending. " +
        "The list takes no filter yet: neither the messenger nor the store filters chats, so a query is refused.",
      input: v.object({ query, limit, page }),
      annotations: READ,
      output: { entity: "chat", list: true },
      served: async (services, args, defaults) => {
        listQuery("chats list", CHATS_QUERY, args.query)
        const { size, number, window } = paging(args, defaults)
        const found = await services.chats.list(window)
        const account = await services.chats.account()
        return listOf("chats list", {
          items: found.items.map((one) => chatAnswer(account, one)),
          limit: size,
          has_more: found.hasMore,
          page: number,
        })
      },
    }),

    chats_events: tool({
      title: "Who joined or left a chat",
      description:
        "A chat's service messages since `since_time`: who joined, left, was added or removed, and by whom, oldest " +
        `first — event is join, leave, add, remove, create, title or pin. ${EVENTS_DAYS} days back if not given. ` +
        "`type` keeps only those events. Returns { items: [{ messageId, timestamp, event, by, people, title? }], page, " +
        "limit, hasMore, chatId, since }; hasMore when the history was longer than one run reads.",
      input: v.object({
        chat,
        since_time: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
        type: v.optional(v.pipe(v.string(), v.description("only these events, comma-separated"))),
      }),
      annotations: READ,
      online: async (adapter, args, { guard }) => {
        const { events, more, ...rest } = await chats(adapter, guard).events(args.chat, {
          ...(args.since_time === undefined ? {} : { since: momentOf(args.since_time, "since_time") }),
          ...(args.type ? { only: args.type } : {}),
        })
        return { ...listed(events), hasMore: more, ...rest }
      },
    }),

    stats_chats_show: tool({
      title: "A chat's numbers for a period",
      description:
        `Counts over a chat's stored messages since \`since_time\` (${EVENTS_DAYS} days back if not given): messages, ` +
        "senders, replies, threads, reactions, views, forwards and comments where the messenger gave them, topPosts, and " +
        "questions { asked, answered, medianMinutesToAnswer }. `by` adds a series row per day or week. Reads the local " +
        "store only, so joins and leaves are not in it — chats_events has them. complete is false when the store does " +
        "not hold the chat whole: then every number is a lower bound, and fetch names the CLI command that fills it.",
      input: v.object({
        chat,
        since_time: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
        by: v.optional(v.picklist(["day", "week"])),
        timezone: v.optional(v.pipe(v.string(), v.description("the IANA timezone for calendar days"))),
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: (store, account, args, defaults) =>
        servicesFor(storedDeps(messenger, store, account, defaults.guard)).chats.stats(args.chat, {
          ...(args.since_time === undefined ? {} : { since: momentOf(args.since_time, "since_time") }),
          ...(args.by ? { by: args.by } : {}),
          ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
        }),
    }),

    chats_members: tool({
      title: "Everyone in a group",
      description:
        "A group's members, a page at a time: { id, name, username, role?, lastSeenAt? }. role is owner, admin or " +
        "member; lastSeenAt is null when their privacy hides it. Returns { items, page, limit, hasMore }.",
      input: v.object({ chat, limit, page }),
      annotations: READ,
      online: async (adapter, { chat: reference, ...rest }, defaults) => {
        const { size, number, window } = paging(rest, defaults)
        const found = await chats(adapter, defaults.guard).members(reference, window)
        return { ...envelope(found, number, size), chatId: found.chatId }
      },
    }),

    chats_members_audit: tool({
      title: "Members that look like bots",
      description:
        "Members of a group that look like bots, highest score first: { id, name, username, score, reasons }. " +
        "Reasons: bot, scam, fake, deleted, no_photo, no_username, odd_name, never_wrote, link_first, burst_join, " +
        "mass_invited. A score is a hint, never a verdict; the owner and admins are left out. Reads the member list " +
        "a page at a time (budget pages); unknown names the signals the messenger gave nothing for; more says some " +
        "members were not read. With deep, the top members also get the full contacts_check, one person a second" +
        (registriesCover(messenger.provider)
          ? " — and their ids are sent to the public ban lists"
          : "; the public ban lists cover Telegram only, so nothing is sent") +
        ". Removes nobody — that is chats_moderate, with the owner's confirmation.",
      input: v.object({
        chat,
        budget: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.description("pages of members to read"))),
        min_score: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
        deep: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50), v.description("check the top n in full")),
        ),
      }),
      annotations: READ,
      online: (adapter, args, { guard, env }) => {
        const key = args.deep === undefined ? undefined : casKey(messenger.app, env)
        return chats(adapter, guard).audit(args.chat, {
          ...(args.budget === undefined ? {} : { budget: args.budget }),
          ...(args.min_score === undefined ? {} : { minScore: args.min_score }),
          ...(args.deep === undefined ? {} : { deep: args.deep }),
          ...(key ? { registry: { casKey: key } } : {}),
        })
      },
    }),

    chats_members_history: tool({
      title: "Who joined, left or changed their profile",
      description:
        "A group's member history as the local store recorded it with chats members fetch, oldest first: " +
        "{ chatId, items: [{ at, event: joined | left | changed, id, name, username, invitedBy?, before? }] }. " +
        "before is the profile seen until then. A leave is recorded only from a member list read whole. Reads the " +
        "local store only; empty until the owner fetches or tracks the chat.",
      input: v.object({
        chat,
        since_time: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const { chatId, events } = await servicesFor(
          storedDeps(messenger, store, account, defaults.guard),
        ).chats.memberHistory(
          args.chat,
          args.since_time === undefined ? {} : { since: momentOf(args.since_time, "since_time") },
        )
        return { chatId, items: events }
      },
    }),

    chats_documents_list: tool({
      title: "Google documents linked in a chat",
      description:
        "Every Google Docs, Sheets, Slides, Forms or Drive link in a chat's stored messages, newest first, one item " +
        "per link: { items: [{ url, documentId, title, inStore, locator, sentAt, sender: { id, name } }], page, " +
        "limit, hasMore }. documentId is the Google file id in the URL, null when it carries none; title is the " +
        "stored document's, null unless inStore. Reads the local store only.",
      input: v.object({ chat, limit, page }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const { size, number, window } = paging(args, defaults)
        const found = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).chatDocuments.list(
          args.chat,
          window,
        )
        return envelope(found, number, size)
      },
    }),

    chats_tracking_list: tool({
      title: "Chats whose members are recorded daily",
      description:
        "The chats whose member lists serve fetches daily into the local store: [{ chatId, title, trackedAt, " +
        "lastCount: { day, participants, listed, complete } | null }]. Reads the local store only. The owner adds " +
        "one with the CLI: chats members fetch <chat> --track, or chats tracking add.",
      input: v.object({}),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account) => ({ items: await store.trackedChats(account) }),
    }),

    chats_tracking_show: tool({
      title: "A chat's member count per day",
      description:
        "Whether a chat's members are recorded daily, and its member count per day for the last 30 days: " +
        "{ chatId, trackedAt | null, counts: [{ day, participants, listed, complete }] }. complete is false for a " +
        "day whose member list was not read whole. Reads the local store only.",
      input: v.object({ chat }),
      annotations: { ...READ, openWorldHint: false },
      stored: (store, account, args, defaults) =>
        servicesFor(storedDeps(messenger, store, account, defaults.guard)).chats.trackedChat(args.chat),
    }),

    chats_inspect: tool({
      title: "What a link leads to",
      description:
        "What an invite or public link leads to, read without joining: { kind, title, id, username, " +
        "participantsCount, description, member, approvalNeeded? }. id is null for a private chat the owner is not in.",
      input: v.object({ link: v.pipe(v.string(), v.minLength(1), v.description("an invite link or a public one")) }),
      annotations: READ,
      online: (adapter, args, { guard }) => chats(adapter, guard).inspect(args.link),
    }),

    chats_send_as: tool({
      title: "Who the owner may post as",
      description:
        "The identities the owner may post as in a chat: { id, title, kind, premiumRequired, default }. kind is " +
        "self, channel or group; self is always there; default is the chat's saved choice. Reading changes nothing. " +
        "Pass an id as messages_send send_as. Returns { items, page, limit, hasMore }.",
      input: v.object({ chat }),
      annotations: READ,
      served: async (services, args) => listed(await services.chats.sendAs(args.chat)),
    }),

    chats_show: tool({
      title: "Show a chat",
      description: "One chat: its kind, unread count, last message time and who is in it.",
      input: v.object({ chat }),
      annotations: READ,
      served: (services, args) => services.chats.show(args.chat),
    }),
  }
}
