import * as v from "valibot"
import { itemOf, snakeKeys } from "../../cli/envelope.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, chatOf, message, tool, WRITE } from "../tool.js"

export const chatsReadTools = (messenger: Messenger): Record<string, AnyTool> => ({
  chats_mark_read: tool({
    title: "Mark a chat read",
    description:
      "Mark a chat read up to a message, or up to its newest message; with topic, only that forum topic. " +
      "The other side sees that it was read. " +
      "Only when the owner asked for it.",
    input: v.object({
      chat: chatOf(messenger),
      until: v.optional(message),
      topic: v.optional(
        v.pipe(v.string(), v.minLength(1), v.description("only this forum topic; unsupported without topics")),
      ),
    }),
    annotations: WRITE,
    permission: "read",
    key: "chats.mark-read",
    online: async (adapter, args, { guard }) =>
      itemOf(
        snakeKeys(
          await servicesFor(onlineDeps(messenger, adapter, guard)).chats.markRead({
            chat: args.chat,
            ...(args.until === undefined ? {} : { until: args.until }),
            ...(args.topic === undefined ? {} : { threadId: args.topic }),
          }),
        ),
      ),
  }),
})
