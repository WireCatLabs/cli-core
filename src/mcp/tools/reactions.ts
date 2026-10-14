import * as v from "valibot"
import { itemOf, snakeKeys } from "../../cli/envelope.js"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import type { SendGuard } from "../../sends/guard.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, chatOf, message, tool, WRITE } from "../tool.js"

/** Offered with `--allow-send`, under the `reaction` permission. */
export const reactionTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const messages = (adapter: MessengerAdapter, guard: SendGuard) =>
    servicesFor(onlineDeps(messenger, adapter, guard)).messages
  return {
    reactions_add: tool({
      title: "React to a message",
      description:
        "Put the owner's reaction on one message; it replaces the one there was. The sender sees it. " +
        "Only when the owner asked for this reaction on this message.",
      input: v.object({
        chat,
        message,
        emoji: v.pipe(v.string(), v.minLength(1), v.description("one emoji, for example 👍")),
      }),
      annotations: WRITE,
      permission: "reaction",
      online: async (adapter, args, { guard }) =>
        itemOf(
          snakeKeys(
            await messages(adapter, guard).react({ chat: args.chat, message: args.message, emoji: args.emoji }),
          ),
        ),
    }),
    reactions_remove: tool({
      title: "Take a reaction off",
      description: "Take the owner's reaction off one message. Only when the owner asked for it.",
      input: v.object({ chat, message }),
      annotations: WRITE,
      permission: "reaction",
      online: async (adapter, args, { guard }) =>
        itemOf(
          snakeKeys(await messages(adapter, guard).react({ chat: args.chat, message: args.message, emoji: null })),
        ),
    }),
  }
}
