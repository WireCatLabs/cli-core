import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { capability } from "../../ports/messenger.js"
import { renderMessages } from "../../render/messages.js"
import { REMOTE_READ } from "../effects.js"
import { listOf, renderAnswer } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"
import { messageItems, selfOf, viewOf } from "./message-items.js"

/** Where to look after a scheduled send ended without an answer: repeating it would schedule a second one. */
export const scheduledCommand = (messenger: Messenger): Command => {
  const command = annotate(new Command("scheduled"), { effects: REMOTE_READ })
    .description("messages waiting to be sent later in a chat, soonest first; cancel one in the app")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { items, reader } = await context.withMessenger(async (connection) => ({
        items: await capability(connection, "scheduled", "list scheduled messages")(chat),
        reader: selfOf(messenger, connection),
      }))
      if (context.format === "pretty" && items.length === 0) return context.renderer.note("nothing scheduled")
      renderAnswer(
        this,
        context,
        listOf("messages scheduled", {
          items: messageItems(items, reader),
          limit: Math.max(items.length, 1),
          has_more: false,
        }),
        () =>
          renderMessages(
            items.map((one) => ({ ...one, timestamp: one.scheduledFor ?? one.timestamp })),
            viewOf(context, messenger),
          ),
      )
    })
  return annotate(command, { output: { entity: "message" } })
}
