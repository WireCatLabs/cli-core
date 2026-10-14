import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { typedSendAs } from "../../sends/send-as.js"
import { renderAnswer } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"
import { afterWrite, writtenAnswer } from "./message-writes.js"

export const forwardCommand = (messenger: Messenger): Command => {
  const forward = annotate(new Command("forward"), { mutates: true })
    .description("forward one message to another chat")
    .argument("<chat>", `the chat the message is in: ${messenger.chatArgument}`)
    .argument("<message>", "the message id")
    .requiredOption("--to <chat>", `where it goes: ${messenger.chatArgument}`)
    .option("--silent", "deliver it without a notification")
    .option(
      "--send-as <id>",
      "post as one of the identities `chats send-as` lists for the --to chat; required where the chat posts as someone else by default",
    )
    .option("--send-id <id>", "repeat a forward whose outcome was unknown, without risking a second copy")
  if (messenger.forwardTopic) forward.option("--topic <id>", "forward into this forum topic of the --to chat")
  return forward.action(async function (this: Command, chat: string, message: string) {
    const context = messengerContext(this, messenger)
    const {
      to,
      silent,
      sendId,
      sendAs: given,
      topic,
    } = this.opts<{
      to: string
      silent?: boolean
      sendId?: string
      sendAs?: string
      topic?: string
    }>()
    const sendAs = typedSendAs(given)
    const { forwarded, reader } = await context.withServices(async (services) => {
      const forwarded = await services.messages.forward({
        chat,
        message: message.trim(),
        to,
        silent: silent === true,
        ...(sendId === undefined ? {} : { sendId }),
        ...(sendAs === undefined ? {} : { sendAs }),
        ...(topic === undefined ? {} : { threadId: topic }),
      })
      return afterWrite(forwarded, async () => ({ forwarded, reader: await services.messages.reader() }))
    })
    await afterWrite(forwarded, () => renderAnswer(this, context, writtenAnswer(forwarded, reader)))
  })
}
