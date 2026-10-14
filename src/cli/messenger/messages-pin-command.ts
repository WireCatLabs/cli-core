import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"

export const pinCommand = (messenger: Messenger): Command =>
  annotate(new Command("pin"), { effects: REMOTE_WRITE })
    .description("pin a message in a chat, quietly unless --notify")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .option("--notify", "tell the chat's members about the pin")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      const { notify } = this.opts<{ notify?: boolean }>()
      const pinned = await context.withServices((services) =>
        services.messages.pin({ chat, message: message.trim(), notify: notify === true }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(pinned)))
    })

export const unpinCommand = (messenger: Messenger): Command =>
  annotate(new Command("unpin"), { effects: REMOTE_WRITE })
    .description("unpin a message in a chat")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      const unpinned = await context.withServices((services) =>
        services.messages.unpin({ chat, message: message.trim() }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(unpinned)))
    })
