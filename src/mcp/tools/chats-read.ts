import * as v from "valibot"
import { itemOf, snakeKeys } from "../../cli/envelope.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, chatOf, message, tool, WRITE } from "../tool.js"

const TOPIC = v.optional(v.pipe(v.string(), v.minLength(1), v.description("only this forum topic")))

export const chatsReadTools = (messenger: Messenger): Record<string, AnyTool> => ({
  chats_mark_read: tool({
    title: "Mark a chat read",
    description:
      `Mark a chat read up to a message, or up to its newest message${messenger.topics === false ? "" : "; with topic, only that forum topic"}. ` +
      "The other side sees that it was read. " +
      "Only when the owner asked for it.",
    input: v.object({
      chat: chatOf(messenger),
      until_id: v.optional(message),
      // Typed as present so the call reads it; offered only where the messenger has forum topics.
      ...((messenger.topics === false ? {} : { topic: TOPIC }) as { topic: typeof TOPIC }),
    }),
    annotations: WRITE,
    permission: "read",
    command: "chats mark-read",
    online: async (adapter, args, { guard }) =>
      itemOf(
        snakeKeys(
          await servicesFor(onlineDeps(messenger, adapter, guard)).chats.markRead({
            chat: args.chat,
            ...(args.until_id === undefined ? {} : { until: args.until_id }),
            ...(args.topic === undefined ? {} : { threadId: args.topic }),
          }),
        ),
      ),
  }),
})
