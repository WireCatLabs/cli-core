import { annotate } from "@wirecat/cli-base/commands"
import { Argument, Command } from "commander"
import { DELETE_AT_ONCE } from "../../services/index.js"
import { commandCapabilities } from "./capabilities.js"
import { type Messenger, messengerContext } from "./context.js"

/**
 * The guard asks first at the default level, `ask`; `--allow-dangerous` is the yes. For everyone only
 * with `--for-everyone` (max-cli `NEED-239`).
 */
export const deleteCommand = (messenger: Messenger): Command => {
  const messages = new Argument("<messages...>", `the message ids, at most ${DELETE_AT_ONCE}`)
  if (commandCapabilities(messenger).commaSeparatedMessageIds)
    messages.argParser((value: string, previous: string[] = []) => [
      ...previous,
      ...value.split(",").map((id) => id.trim()),
    ])
  return annotate(new Command("delete"), { mutates: true })
    .description("delete messages for you only; with --for-everyone, for everyone in the chat")
    .argument("<chat>", messenger.chatArgument)
    .addArgument(messages)
    .option("--for-everyone", "delete for everyone in the chat, not only for you — they cannot get it back")
    .option("--allow-dangerous", "go ahead without the question an ask level puts before a deletion")
    .action(async function (this: Command, chat: string, messages: string[]) {
      const context = messengerContext(this, messenger)
      const everyone = this.opts<{ forEveryone?: boolean }>().forEveryone === true
      context.renderer.result(
        await context.withServices((services) =>
          services.messages.delete({
            chat,
            messages: messages.map((one) => one.trim()),
            forEveryone: everyone,
          }),
        ),
      )
    })
}
