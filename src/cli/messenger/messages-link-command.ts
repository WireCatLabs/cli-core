import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { itemOf, renderAnswer } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"

export const messageLinkCommand = (messenger: Messenger): Command => {
  const command = new Command("link")
    .description("a message permalink when supported, and its account-scoped locator")
    .argument("<chat>", `${messenger.chatArgument}; or a msg: locator, with no message id after it`)
    .argument("[message]", "the message id")
    .action(async function (this: Command, chat: string, message: string | undefined) {
      const context = messengerContext(this, messenger)
      const { locator, ...link } = await context.withServices((services) => services.messages.link(chat, message))
      if (context.format === "pretty")
        context.renderer.note(
          link.url ? `link access: ${link.access}; a link grants no membership` : `no permalink: ${link.reason}`,
        )
      renderAnswer(this, context, itemOf({ ref: locator, ...link }), () => `${link.url ?? locator}\n`)
    })
  return annotate(command, { output: { entity: "message_link" } })
}
