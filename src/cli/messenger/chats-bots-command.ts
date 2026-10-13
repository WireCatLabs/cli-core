import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { guardedApp, guardedStart } from "../../sends/buttons.js"
import { itemOf, renderAnswer } from "../envelope.js"
import { snakeKeys } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"

/** `chats start` and `chats app` — a bot in a one-to-one chat with the personal account. */
export const botChatCommands = (messenger: Messenger): Command[] => [
  annotate(new Command("start"), { mutates: true })
    .description("start a bot, as its Start button does; the bot sees that you started it")
    .argument("<bot>", "the chat with the bot — its id or its name — or the bot's link, even one never opened")
    .option("--payload <text>", "the start parameter the bot reads; a link's own ?start= when not given")
    .action(async function (this: Command, bot: string) {
      const context = messengerContext(this, messenger)
      const { payload } = this.opts<{ payload?: string }>()
      renderAnswer(
        this,
        context,
        itemOf(
          snakeKeys(
            await context.withMessenger((connection) =>
              guardedStart(context.guard, connection, { chat: bot, ...(payload === undefined ? {} : { payload }) }),
            ),
          ),
        ),
      )
    }),
  annotate(new Command("app"), { mutates: true })
    .description("the address that opens a bot's mini app, signed in as you — keep it to yourself")
    .argument("<bot>", "the chat with the bot: its id or its name")
    .option("--start <param>", "the start parameter the app reads")
    .action(async function (this: Command, bot: string) {
      const context = messengerContext(this, messenger)
      const { start } = this.opts<{ start?: string }>()
      renderAnswer(
        this,
        context,
        itemOf(
          snakeKeys(
            await context.withMessenger((connection) =>
              guardedApp(context.guard, connection, {
                chat: bot,
                ...(start === undefined ? {} : { startParam: start }),
              }),
            ),
          ),
        ),
      )
    }),
]
