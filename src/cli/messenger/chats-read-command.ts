import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"

export const markReadCommand = (messenger: Messenger): Command =>
  annotate(new Command("mark-read"), { mutates: true })
    .description("mark a chat read; the other side sees that you read it")
    .argument("<chat>", messenger.chatArgument)
    .option("--until <message>", "only up to this message id; the newest by default")
    .option("--topic <id>", "mark only this forum topic read; unsupported by messengers without topics")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { until, topic } = this.opts<{ until?: string; topic?: string }>()
      renderAnswer(
        this,
        context,
        itemOf(
          snakeKeys(
            await context.withServices((services) =>
              services.chats.markRead({
                chat,
                ...(until === undefined ? {} : { until: until.trim() }),
                ...(topic === undefined ? {} : { threadId: topic }),
              }),
            ),
          ),
        ),
      )
    })
