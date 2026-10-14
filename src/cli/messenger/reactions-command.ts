import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"

/** `reactions add|remove`: the owner's own reaction on a message. */
export const reactionsCommand = (messenger: Messenger): Command => {
  const reactions = new Command("reactions").description("react to messages")

  annotate(reactions.command("add"), { effects: REMOTE_WRITE })
    .description("put your reaction on a message; it replaces the one you had")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .argument("<emoji>", "one emoji, for example 👍")
    .action(async function (this: Command, chat: string, message: string, emoji: string) {
      const context = messengerContext(this, messenger)
      const reacted = await context.withServices((services) =>
        services.messages.react({ chat, message: message.trim(), emoji: emoji.trim() }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(reacted)))
    })

  annotate(reactions.command("remove"), { effects: REMOTE_WRITE })
    .description("take your reaction off a message")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      const reacted = await context.withServices((services) =>
        services.messages.react({ chat, message: message.trim(), emoji: null }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(reacted)))
    })

  return reactions
}
