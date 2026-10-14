import * as v from "valibot"
import { itemOf, snakeKeys } from "../../cli/envelope.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { DELETE_AT_ONCE, onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, chatOf, message, tool, WRITE } from "../tool.js"

export const messageDeleteTools = (messenger: Messenger): Record<string, AnyTool> => ({
  messages_delete: tool({
    title: "Delete messages for the owner",
    description:
      `Delete up to ${DELETE_AT_ONCE} messages from the owner's view of a chat; the other people still see them. ` +
      "Cannot be undone. Only when the owner asked for these exact messages to be deleted.",
    input: v.object({
      chat: chatOf(messenger),
      messages: v.pipe(v.array(message), v.minLength(1), v.maxLength(DELETE_AT_ONCE)),
    }),
    annotations: WRITE,
    permission: "delete",
    online: async (adapter, args, { guard }) =>
      itemOf(
        snakeKeys(
          await servicesFor(onlineDeps(messenger, adapter, guard)).messages.delete({
            chat: args.chat,
            messages: args.messages,
            forEveryone: false,
          }),
        ),
      ),
  }),
})
