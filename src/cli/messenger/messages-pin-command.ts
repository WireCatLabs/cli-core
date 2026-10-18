import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { pinDurationOf, pinLengthHelp } from "../../domain/pin-duration.js"
import { REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"

export const pinCommand = (messenger: Messenger): Command => {
  const tool = messenger.app.command
  const quiet = messenger.quietPins !== false
  const durations = messenger.pinDurations?.length ? messenger.pinDurations : undefined
  const command = annotate(new Command("pin"), {
    effects: REMOTE_WRITE,
    examples: [
      `${tool} messages pin <chat> <message>`,
      ...(quiet ? [`${tool} messages pin <chat> <message> --notify`] : []),
      ...(durations ? [`${tool} messages pin <chat> <message> --expire-time 24h`] : []),
    ],
  })
    .description(
      quiet ? "pin a message in a chat, quietly unless --notify" : "pin a message in a chat; its members are told",
    )
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
  if (quiet) command.option("--notify", "tell the chat's members about the pin")
  if (durations) command.option("--expire-time <time>", pinLengthHelp(durations, messenger.pinDefaultDuration))
  return command.action(async function (this: Command, chat: string, message: string) {
    const context = messengerContext(this, messenger)
    const { notify, expireTime } = this.opts<{ notify?: boolean; expireTime?: string }>()
    const duration = pinDurationOf(expireTime, durations)
    const pinned = await context.withServices((services) =>
      services.messages.pin({
        chat,
        message: message.trim(),
        notify: notify === true,
        ...(duration === undefined ? {} : { duration }),
      }),
    )
    renderAnswer(this, context, itemOf(snakeKeys(pinned)))
  })
}

export const unpinCommand = (messenger: Messenger): Command =>
  annotate(new Command("unpin"), {
    effects: REMOTE_WRITE,
    examples: [`${messenger.app.command} messages unpin <chat> <message>`],
  })
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

/** `messages star` and `unstar` — the owner's own mark on a message; nobody in the chat sees it. */
export const starCommands = (messenger: Messenger): Command[] =>
  [true, false].map((starred) => {
    const name = starred ? "star" : "unstar"
    return annotate(new Command(name), {
      effects: REMOTE_WRITE,
      examples: [`${messenger.app.command} messages ${name} <chat> <message>`],
    })
      .description(
        starred ? "star a message, so it is easy to find again; only you see the star" : "take the star off a message",
      )
      .argument("<chat>", messenger.chatArgument)
      .argument("<message>", "the message id")
      .action(async function (this: Command, chat: string, message: string) {
        const context = messengerContext(this, messenger)
        const answer = await context.withServices((services) =>
          services.messages.star({ chat, message: message.trim(), starred }),
        )
        renderAnswer(this, context, itemOf(snakeKeys(answer)))
      })
  })
