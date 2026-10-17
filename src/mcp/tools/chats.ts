import * as v from "valibot"
import { registriesCover } from "../../botcheck/registries.js"
import { itemOf, listOf, snakeKeys } from "../../cli/envelope.js"
import { queryArgument } from "../../cli/list-query.js"
import { chatShown, documentLinkAnswer, wholeList } from "../../cli/messenger/chat-answers.js"
import { chatEvents, chatsList, membersAudit, membersHistory, membersList } from "../../cli/messenger/chat-lists.js"
import { AUDIT_QUERY, CHATS_QUERY, EVENTS_QUERY, HISTORY_QUERY } from "../../cli/messenger/chat-queries.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { chatStatsAnswer } from "../../cli/messenger/stats-answers.js"
import { casKey } from "../../cli/registry-keys.js"
import { nextStep } from "../../cli/steps.js"
import { syncsOneChat } from "../../ports/traits.js"
import { EVENTS_DAYS, onlineDeps, servicesFor, storedDeps } from "../../services/index.js"
import { momentOf } from "../../services/moment.js"
import { type AnyTool, chatOf, limit, page, paging, READ, tool } from "../tool.js"

const pagingOf = (args: { limit?: number; page?: number }, defaults: { limit: number }) => {
  const { size, number } = paging(args, defaults as Parameters<typeof paging>[1])
  return { limit: size, page: number }
}

export const chatsTools = (messenger: Messenger): Record<string, AnyTool> => {
  const tools = chatTools(messenger)
  if (messenger.sendAs === false) delete tools.chats_send_as
  return tools
}

const chatTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  return {
    chats_list: tool({
      title: "List chats",
      description:
        "Chats the owner is in, most recent first. Use it to find a chat's id before reading or sending. " +
        "query (kind:group unread_count>0, title:book) is answered from the local store: when the chats are read " +
        "from the messenger it filters nothing, and a query is refused.",
      input: v.object({ query: queryArgument(CHATS_QUERY), limit, page }),
      annotations: READ,
      output: { entity: "chat", list: true },
      served: (services, args, defaults) => chatsList(services, args.query, pagingOf(args, defaults)),
    }),

    chats_events: tool({
      title: "Who joined or left a chat",
      description:
        "A chat's service messages: who joined, left, was added or removed, and by whom, oldest first — type is " +
        `join, leave, add, remove, create, title or pin. The last ${EVENTS_DAYS} days unless query names time ` +
        '(time>=2d, time>="2026-10-01"). meta.truncated when the history was longer than one run reads.',
      input: v.object({ chat, query: queryArgument(EVENTS_QUERY) }),
      annotations: READ,
      output: { entity: "chat_event", list: true },
      online: (adapter, args, { guard }) =>
        chatEvents(servicesFor(onlineDeps(messenger, adapter, guard)), args.chat, args.query),
    }),

    stats_chats_show: tool({
      title: "A chat's numbers for a period",
      description:
        `Counts over a chat's stored messages since \`since_time\` (${EVENTS_DAYS} days back if not given): messages, ` +
        "senders, replies, threads, reactions, views, forwards and comments where the messenger gave them, top_posts, and " +
        "questions { asked, answered, median_minutes_to_answer }. `by` adds a series row per day or week. Reads the local " +
        "store only, so joins and leaves are not in it — `chats events` has them. complete is false when the store does " +
        "not hold the chat whole: then every number is a lower bound, and next names the sync that fills it.",
      input: v.object({
        chat,
        since_time: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
        by: v.optional(v.picklist(["day", "week"])),
        timezone: v.optional(v.pipe(v.string(), v.description("the IANA timezone for calendar days"))),
      }),
      annotations: { ...READ, openWorldHint: false },
      output: { entity: "chat_stats", list: false },
      stored: async (store, account, args, defaults) =>
        chatStatsAnswer(
          await servicesFor(storedDeps(messenger, store, account, defaults.guard)).chats.stats(args.chat, {
            ...(args.since_time === undefined ? {} : { since: momentOf(args.since_time, "since_time") }),
            ...(args.by ? { by: args.by } : {}),
            ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
          }),
          account,
        ),
    }),

    chats_members: tool({
      title: "Everyone in a group",
      description:
        "A group's members, a page at a time: { id, name, username, role?, last_seen_at? }. role is owner, admin or " +
        "member; last_seen_at is null when their privacy hides it.",
      input: v.object({ chat, limit, page }),
      annotations: READ,
      command: "chats members list",
      output: { entity: "member", list: true },
      online: (adapter, args, defaults) =>
        membersList(servicesFor(onlineDeps(messenger, adapter, defaults.guard)), args.chat, pagingOf(args, defaults)),
    }),

    chats_members_audit: tool({
      title: "Members that look like bots",
      description:
        "Members of a group that look like bots, highest score first: { id, name, username, score, reasons }. " +
        "Reasons: bot, scam, fake, deleted, no_photo, no_username, odd_name, never_wrote, link_first, burst_join, " +
        "mass_invited. A score is a hint, never a verdict; the owner and admins are left out. query sets the lowest " +
        "score shown (score>=3; score>=2 unless named). Reads the member list a page at a time, at most max_pages; " +
        "meta.truncated says some members were not read. With deep, the top members also get the full `contacts check`, " +
        "one person a second" +
        (registriesCover(messenger.provider)
          ? " — and their ids are sent to the public ban lists"
          : "; the public ban lists cover Telegram only, so nothing is sent") +
        ". Removes nobody — that is `chats moderate`, with the owner's confirmation.",
      input: v.object({
        chat,
        query: queryArgument(AUDIT_QUERY),
        max_pages: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.description("pages of members to read")),
        ),
        deep: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50), v.description("check the top n in full")),
        ),
      }),
      annotations: READ,
      output: { entity: "member", list: true },
      online: async (adapter, args, { guard, env, keyring }) => {
        const key = args.deep === undefined ? undefined : casKey(messenger.app, env, keyring)
        const { body } = await membersAudit(servicesFor(onlineDeps(messenger, adapter, guard)), args.chat, args.query, {
          ...(args.max_pages === undefined ? {} : { budget: args.max_pages }),
          ...(args.deep === undefined ? {} : { deep: args.deep }),
          ...(key ? { registry: { casKey: key } } : {}),
        })
        return body
      },
    }),

    chats_members_history: tool({
      title: "Who joined, left or changed their profile",
      description:
        "A group's member history as the local store recorded it with chats members fetch, oldest first: type is " +
        "join, leave or profile; before is the profile seen until then. A leave is recorded only from a member list " +
        "read whole. query names time to read from (time>=7d). Reads the local store only; empty until the owner " +
        "fetches or tracks the chat.",
      input: v.object({ chat, query: queryArgument(HISTORY_QUERY) }),
      annotations: { ...READ, openWorldHint: false },
      output: { entity: "chat_event", list: true },
      stored: (store, account, args, defaults) =>
        membersHistory(servicesFor(storedDeps(messenger, store, account, defaults.guard)), args.chat, args.query),
    }),

    chats_documents_list: tool({
      title: "Google documents linked in a chat",
      description:
        "Every Google Docs, Sheets, Slides, Forms or Drive link in a chat's stored messages, newest first, one item " +
        "per link: { url, document_id, title, in_store, ref, sent_at, sender: { id, name } }. document_id is the " +
        "Google file id in the URL, null when it carries none; title is the stored document's, null unless in_store; " +
        "ref is the message's locator. Reads the local store only.",
      input: v.object({ chat, limit, page }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const { size, number, window } = paging(args, defaults)
        const found = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).chatDocuments.list(
          args.chat,
          window,
        )
        return listOf("chats documents list", {
          items: found.items.map(documentLinkAnswer),
          limit: size,
          has_more: found.hasMore,
          page: number,
          args: { chat: args.chat },
          ...(found.empty && syncsOneChat(messenger)
            ? { next: [nextStep("messages.sync", { args: { chat: found.chatId } })] }
            : {}),
        })
      },
    }),

    chats_tracking_list: tool({
      title: "Chats whose members are recorded daily",
      description:
        "The chats whose member lists serve fetches daily into the local store: { chat_id, title, tracked_at, " +
        "last_count: { day, participants, listed, complete } | null }. Reads the local store only. The owner adds " +
        "one with the CLI: chats members fetch <chat> --track, or chats tracking add.",
      input: v.object({}),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account) =>
        wholeList("chats tracking list", (await store.roster.trackedChats(account)).map(snakeKeys)),
    }),

    chats_tracking_show: tool({
      title: "A chat's member count per day",
      description:
        "Whether a chat's members are recorded daily, and its member count per day for the last 30 days: " +
        "{ chat_id, tracked_at | null, counts: [{ day, participants, listed, complete }] }. complete is false for a " +
        "day whose member list was not read whole. Reads the local store only.",
      input: v.object({ chat }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) =>
        itemOf(
          snakeKeys(
            await servicesFor(storedDeps(messenger, store, account, defaults.guard)).chats.trackedChat(args.chat),
          ),
        ),
    }),

    chats_inspect: tool({
      title: "What a link leads to",
      description:
        "What an invite or public link leads to, read without joining: { kind, title, id, username, " +
        "participants_count, description, member, approval_needed? }. id is null for a private chat the owner is not in.",
      input: v.object({ link: v.pipe(v.string(), v.minLength(1), v.description("an invite link or a public one")) }),
      annotations: READ,
      online: async (adapter, args, { guard }) =>
        itemOf(snakeKeys(await servicesFor(onlineDeps(messenger, adapter, guard)).chats.inspect(args.link))),
    }),

    chats_send_as: tool({
      title: "Who the owner may post as",
      description:
        "The identities the owner may post as in a chat: { id, title, kind, premium_required, default }. kind is " +
        "self, channel or group; self is always there; default is the chat's saved choice. Reading changes nothing. " +
        "Pass an id as `send_as` to `messages send`.",
      input: v.object({ chat }),
      annotations: READ,
      command: "chats send-as",
      served: async (services, args) =>
        wholeList("chats send-as", (await services.chats.sendAs(args.chat)).map(snakeKeys)),
    }),

    chats_show: tool({
      title: "Show a chat",
      description:
        "One chat: its kind, unread count, last message time and who is in it; a group's description, invite link " +
        "and settings where the messenger gives them.",
      input: v.object({ chat }),
      annotations: READ,
      output: { entity: "chat", list: false },
      served: async (services, args) => chatShown(await services.chats.account(), await services.chats.show(args.chat)),
    }),
  }
}
