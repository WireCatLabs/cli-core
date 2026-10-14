import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { guardedPress } from "../../sends/buttons.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"

/** `messages press` — one of a bot's callback buttons; the bot sees who pressed it. */
export const pressCommand = (messenger: Messenger): Command =>
  annotate(new Command("press"), { mutates: true })
    .description("press a bot's button under a message; the bot sees that you pressed it")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of the message with the buttons")
    .argument("<button>", "its number as `messages show` prints it, or its exact text")
    .action(async function (this: Command, chat: string, message: string, button: string) {
      const context = messengerContext(this, messenger)
      const pressed = await context.withMessenger((connection) =>
        guardedPress(context.guard, connection, { chat, message: message.trim(), button }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(pressed)))
    })
