import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { type Messenger, messengerContext } from "./context.js"

export const pinCommand = (messenger: Messenger): Command =>
  annotate(new Command("pin"), { mutates: true })
    .description("pin a message in a chat, quietly unless --notify")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .option("--notify", "tell the chat's members about the pin")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      const { notify } = this.opts<{ notify?: boolean }>()
      context.renderer.result(
        await context.withServices((services) =>
          services.messages.pin({ chat, message: message.trim(), notify: notify === true }),
        ),
      )
    })

export const unpinCommand = (messenger: Messenger): Command =>
  annotate(new Command("unpin"), { mutates: true })
    .description("unpin a message in a chat")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withServices((services) => services.messages.unpin({ chat, message: message.trim() })),
      )
    })
