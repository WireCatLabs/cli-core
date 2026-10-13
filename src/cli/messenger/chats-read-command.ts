import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { topicOption } from "./capabilities.js"
import { type Messenger, messengerContext } from "./context.js"

export const markReadCommand = (messenger: Messenger): Command =>
  topicOption(
    annotate(new Command("mark-read"), { mutates: true })
      .description("mark a chat read; the other side sees that you read it")
      .argument("<chat>", messenger.chatArgument)
      .option("--until <message>", "only up to this message id; the newest by default"),
    messenger,
    "mark only this forum topic read",
    "markRead",
  ).action(async function (this: Command, chat: string) {
    const context = messengerContext(this, messenger)
    const { until, topic } = this.opts<{ until?: string; topic?: string }>()
    context.renderer.result(
      await context.withServices((services) =>
        services.chats.markRead({
          chat,
          ...(until === undefined ? {} : { until: until.trim() }),
          ...(topic === undefined ? {} : { threadId: topic }),
        }),
      ),
    )
  })
