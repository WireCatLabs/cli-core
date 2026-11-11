import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { FETCH } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"
import { imageModelsCommand } from "./models-command.js"

const DEFAULT_LIMIT = 100

/**
 * `images`: what the pictures themselves show, for the profiles that turned `picture_search` on. A picture is
 * read through the messenger's own download, its vector kept, the file dropped; nothing is sent or marked read.
 */
export const imagesCommand = (messenger: Messenger): Command => {
  const images = new Command("images").description("search pictures by what they show, with a model on this machine")

  annotate(images.command("embed"), {
    output: { entity: "image_embedding" },
    effects: FETCH,
    offline: false,
    examples: [`${messenger.app.command} images embed`, `${messenger.app.command} images embed --limit 500`],
  })
    .summary("compute a vector for each stored picture that has none; resumes where it stopped")
    .description(
      "compute a vector for each picture the store knows and has none for — downloading it through the messenger, " +
        "keeping only the vector; needs `picture_search` on in the profile and `images models download clip-b32`; " +
        "resumes where it stopped",
    )
    .option("--chat <chat>", `only this chat; ${messenger.chatArgument}`)
    .option(
      "--limit <n>",
      `at most this many pictures in one run; ${DEFAULT_LIMIT} if not given`,
      positiveCount("--limit"),
    )
    .action(async function (this: Command) {
      const { chat, limit = DEFAULT_LIMIT } = this.opts<{ chat?: string; limit?: number }>()
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "conversations.embeddings")
      const controller = new AbortController()
      context.track({ close: async () => controller.abort() })
      const done = await context.withServices((services) =>
        services.pictures.embed({ ...(chat === undefined ? {} : { chat }), limit, signal: controller.signal }),
      )
      if (context.format === "pretty") {
        context.streams.data(
          `${done.embedded} pictures embedded with ${done.model}` +
            `${done.skipped ? `, ${done.skipped} not readable` : ""}${done.failed ? `, ${done.failed} failed` : ""}\n`,
        )
        if (done.more) context.renderer.note("more pictures are left — run it again")
      } else renderAnswer(this, context, itemOf(snakeKeys(done)))
    })

  annotate(images.command("read"), {
    output: { entity: "attachment_text_change" },
    effects: FETCH,
    offline: false,
    examples: [
      `${messenger.app.command} images read "msg:..." --attachment 1`,
      `${messenger.app.command} images read "Book club" 101`,
    ],
  })
    .summary("have your coding agent read the text of one picture, and keep it for search")
    .description(
      "give one picture of a message to the coding agent chosen in `models picture-reading` (Claude Code or Codex) " +
        "and keep the text it read, so search finds it; the picture goes to that agent's provider. Refused while " +
        "picture reading is never; the saved copy is used when there is one, else the messenger's download",
    )
    .argument("<chat>", `${messenger.chatArgument}; or a msg: locator, with no message id after it`)
    .argument("[message]", "the message id")
    .option(
      "--attachment <n>",
      "which file of the message, from 1; needed when it has more than one",
      positiveCount("--attachment"),
    )
    .action(async function (this: Command, chat: string, message: string | undefined) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "attachments.update")
      const { attachment } = this.opts<{ attachment?: number }>()
      const controller = new AbortController()
      context.track({ close: async () => controller.abort() })
      const done = await context.withServices((services) =>
        services.attachments.readPicture({
          chat,
          ...(message === undefined ? {} : { message }),
          ...(attachment === undefined ? {} : { attachment }),
          signal: controller.signal,
        }),
      )
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(done)),
        () => `${done.ref} #${done.attachment}  ${done.chars} characters read by ${done.extractor}\n${done.text}\n`,
      )
    })

  images.addCommand(imageModelsCommand(messenger))
  return images
}
