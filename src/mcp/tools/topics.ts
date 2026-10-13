import * as v from "valibot"
import { itemOf, listOf } from "../../cli/envelope.js"
import { snakeKeys, topicAnswer } from "../../cli/messenger/chat-answers.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { capability } from "../../cli/messenger/port.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, chatOf, type Defaults, limit, page, paging, READ, tool, WRITE } from "../tool.js"

const topicsPage = async (
  adapter: Parameters<NonNullable<AnyTool["online"]>>[0],
  chat: string,
  search: string | undefined,
  rest: { limit?: number; page?: number },
  defaults: Defaults,
) => {
  const { size, number, window } = paging(rest, defaults)
  const found = await capability(
    adapter,
    "topics",
    "list forum topics",
  )(chat, {
    ...window,
    ...(search === undefined ? {} : { search }),
  })
  return listOf(search === undefined ? "topics list" : "search topics", {
    items: found.items.map(topicAnswer),
    limit: size,
    has_more: found.hasMore,
    page: number,
    args: { chat, ...(search === undefined ? {} : { text: search }) },
  })
}

export const topicsTools = (messenger: Messenger): Record<string, AnyTool> => ({
  topics_list: tool({
    title: "A forum group's topics",
    description:
      "The topics of a forum group, newest activity first. A message in a topic carries its id as its thread. " +
      "search_topics matches titles.",
    input: v.object({ chat: chatOf(messenger), limit, page }),
    annotations: READ,
    output: { entity: "topic", list: true },
    online: async (adapter, { chat, ...rest }, defaults) => topicsPage(adapter, chat, undefined, rest, defaults),
  }),
  search_topics: tool({
    title: "Find a forum group's topics by title",
    description: "A forum group's topics whose title matches, asked of the messenger, newest activity first.",
    input: v.object({
      chat: chatOf(messenger),
      text: v.pipe(v.string(), v.minLength(1), v.description("words from the topic's title")),
      limit,
      page,
    }),
    annotations: READ,
    output: { entity: "topic", list: true },
    online: async (adapter, { chat, text, ...rest }, defaults) => topicsPage(adapter, chat, text, rest, defaults),
  }),
  ...(messenger.topicShow
    ? {
        topics_show: tool({
          title: "One forum topic",
          description: "One topic of a forum group. Reading changes nothing.",
          input: v.object({
            chat: chatOf(messenger),
            topic: v.pipe(v.string(), v.minLength(1), v.description("the topic id, from topics_list")),
          }),
          annotations: { ...READ, idempotentHint: true },
          output: { entity: "topic", list: false },
          online: async (adapter, args, { guard }) =>
            itemOf(
              topicAnswer(await servicesFor(onlineDeps(messenger, adapter, guard)).topics.show(args.chat, args.topic)),
            ),
        }),
      }
    : {}),
})

export const topicWriteTools = (messenger: Messenger): Record<string, AnyTool> => ({
  topics_enable: tool({
    title: "Enable forum topics",
    description:
      "Only when the owner requested this change. A basic group requires explicit upgrade; its id changes. A partial failure reports the new chat id. Only the group owner can enable topics.",
    input: v.object({ chat: chatOf(messenger), upgrade: v.optional(v.boolean()) }),
    annotations: WRITE,
    permission: "groups",
    online: async (adapter, args, { guard }) =>
      itemOf(
        snakeKeys(
          await servicesFor(onlineDeps(messenger, adapter, guard)).topics.enable(args.chat, {
            upgrade: args.upgrade === true,
          }),
        ),
      ),
  }),
  topics_create: tool({
    title: "Create a forum topic",
    description:
      "Only when the owner requested this topic. The group must already have topics enabled. On outcome_unknown, check topics_list and do not repeat the creation, even with the same send_id.",
    input: v.object({
      chat: chatOf(messenger),
      title: v.pipe(v.string(), v.minLength(1)),
      send_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    }),
    annotations: WRITE,
    permission: "groups",
    online: async (adapter, args, { guard }) =>
      itemOf(
        snakeKeys(
          await servicesFor(onlineDeps(messenger, adapter, guard)).topics.create(args.chat, args.title, {
            ...(args.send_id === undefined ? {} : { sendId: args.send_id }),
          }),
        ),
      ),
  }),
  topics_delete: tool({
    title: "Delete a forum topic",
    description:
      "Only when the owner asked to delete this topic. Deletes the topic and every message in it, for everyone; it " +
      "cannot be undone, and asks first unless topics.delete is allow. The General topic (1) cannot be deleted. " +
      "Returns { operation_id, chat_id, topic_id }. On outcome_unknown, read topics_list: a topic that is gone was deleted.",
    input: v.object({
      chat: chatOf(messenger),
      topic: v.pipe(v.string(), v.minLength(1), v.description("the topic id, from topics_list")),
    }),
    annotations: WRITE,
    permission: "groups",
    online: async (adapter, args, { guard }) =>
      itemOf(snakeKeys(await servicesFor(onlineDeps(messenger, adapter, guard)).topics.delete(args.chat, args.topic))),
  }),
  topics_edit: tool({
    title: "Rename, close, reopen, pin or unpin a forum topic",
    description:
      "Only when the owner requested this change. title renames the topic; closed: true closes it to new messages, " +
      "false reopens it; pinned: true pins it, false unpins it; hidden hides or shows the General topic. Returns { operation_id, chat_id, topic }. On outcome_unknown, repeating it is safe.",
    input: v.object({
      chat: chatOf(messenger),
      topic: v.pipe(v.string(), v.minLength(1), v.description("the topic id, from topics_list")),
      title: v.optional(v.pipe(v.string(), v.minLength(1))),
      closed: v.optional(v.boolean()),
      pinned: v.optional(v.boolean()),
      hidden: v.optional(v.pipe(v.boolean(), v.description("the General topic only"))),
    }),
    annotations: WRITE,
    permission: "groups",
    online: async (adapter, args, { guard }) =>
      itemOf(
        snakeKeys(
          await servicesFor(onlineDeps(messenger, adapter, guard)).topics.edit(args.chat, args.topic, {
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.closed === undefined ? {} : { closed: args.closed }),
            ...(args.pinned === undefined ? {} : { pinned: args.pinned }),
            ...(args.hidden === undefined ? {} : { hidden: args.hidden }),
          }),
        ),
      ),
  }),
  topics_order: tool({
    title: "Order the pinned forum topics",
    description:
      "Only when the owner requested this order. Puts the pinned topics in the order given; it pins and unpins " +
      "nothing. Returns { operation_id, chat_id, order }. On outcome_unknown, repeating it is safe.",
    input: v.object({
      chat: chatOf(messenger),
      topics: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
    }),
    annotations: WRITE,
    permission: "groups",
    online: async (adapter, args, { guard }) =>
      itemOf(snakeKeys(await servicesFor(onlineDeps(messenger, adapter, guard)).topics.order(args.chat, args.topics))),
  }),
})
