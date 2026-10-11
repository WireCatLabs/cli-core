import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { type Messenger, messengerContext } from "./context.js"

/** `reactions add|remove`: the owner's own reaction on a message. */
export const reactionsCommand = (messenger: Messenger): Command => {
  const reactions = new Command("reactions").description("react to messages")

  annotate(reactions.command("add"), { mutates: true })
    .description("put your reaction on a message; it replaces the one you had")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .argument("<emoji>", "one emoji, for example 👍")
    .action(async function (this: Command, chat: string, message: string, emoji: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withServices((services) =>
          services.messages.react({ chat, message: message.trim(), emoji: emoji.trim() }),
        ),
      )
    })

  annotate(reactions.command("remove"), { mutates: true })
    .description("take your reaction off a message")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withServices((services) =>
          services.messages.react({ chat, message: message.trim(), emoji: null }),
        ),
      )
    })

  return reactions
}
