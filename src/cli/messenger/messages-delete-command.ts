import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { DELETE_AT_ONCE } from "../../services/index.js"
import { environmentOf } from "../context.js"
import { ownerOnlyOption, REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { lineOf } from "../steps.js"
import { type Messenger, messengerContext } from "./context.js"

/**
 * The guard asks first at the default level, `ask`; `--allow-dangerous` is the yes. For everyone only
 * with `--for-everyone` (max-cli `NEED-239`), and never for an agent (NEED-1423).
 */
export const deleteCommand = (messenger: Messenger): Command =>
  annotate(new Command("delete"), {
    examples: [`${messenger.app.command} personal messages delete "Book club" 101`],
    effects: REMOTE_WRITE,
    output: { entity: "message_deletion" },
  })
    .description("delete messages for you only; with --for-everyone, for everyone in the chat")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message...>", `the message ids, by spaces or commas, at most ${DELETE_AT_ONCE}`)
    .addOption(
      ownerOnlyOption("--for-everyone", "delete for everyone in the chat, not only for you — they cannot get it back"),
    )
    .addOption(
      ownerOnlyOption("--allow-dangerous", "go ahead without the question an ask level puts before a deletion"),
    )
    .action(async function (this: Command, chat: string, messages: string[]) {
      const everyone = this.opts<{ forEveryone?: boolean }>().forEveryone === true
      if (environmentOf(this).agent && (everyone || messenger.deleteForMe === false))
        throw new CliError(
          "permission_error",
          `${everyone ? "" : `${messenger.name ?? messenger.provider} deletes only for everyone, and `}an agent never ` +
            `deletes for everyone — the owner can run \`${lineOf(this, "messages delete --for-everyone")}\``,
          { permission: "messages.delete", sent: false },
        )
      const ids = messages
        .flatMap((one) => one.split(","))
        .map((one) => one.trim())
        .filter(Boolean)
      if (ids.length === 0)
        throw new CliError("validation_error", "no message id given — name the messages to delete", { sent: false })
      const context = messengerContext(this, messenger)
      const deleted = await context.withServices((services) =>
        services.messages.delete({ chat, messages: ids, forEveryone: everyone }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(deleted)))
    })
