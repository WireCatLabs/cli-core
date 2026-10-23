import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { FETCH, LOCAL_READ } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"

export const metadataCommand = (messenger: Messenger): Command => {
  const tool = messenger.app.command
  const command = new Command("metadata").description("cached group/channel descriptions for local automatic tags")
  annotate(command.command("show"), {
    output: { entity: "chat_metadata" },
    effects: LOCAL_READ,
    examples: [`${tool} metadata show --chat 7`],
  })

    .description("a stored chat's cached description, as automatic tags read it")
    .requiredOption("--chat <chat>", "a stored chat")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const { chat } = this.opts<{ chat: string }>()
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(await context.withServices((services) => services.metadata.get(chat)))),
      )
    })
  annotate(command.command("sync"), {
    output: { entity: "chat_metadata_refresh" },

    effects: FETCH,
    examples: [`${tool} metadata sync --chat 7 --chat 8`, `${tool} metadata sync --only-missing --limit 20`],
  })
    .description("fetch group and channel descriptions again and cache them")
    .option(
      "--chat <chat>",
      "stored group/channel; repeat for several",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--only-missing", "only chats with no metadata yet; without --chat, every stored group/channel")
    .option("--limit <n>", "process at most 1–500 chats", positiveCount("--limit"), 50)
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "metadata.sync")
      const options = this.opts<{ chat: string[]; onlyMissing?: boolean; limit: number }>()
      const limit = Number(options.limit)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new CliError("validation_error", "--limit takes 1–500")
      if (options.chat.length === 0 && !options.onlyMissing)
        throw new CliError("validation_error", "name a chat with --chat, or give --only-missing")
      const chats = options.onlyMissing
        ? await context.withServices((services) => services.metadata.missing(options.chat))
        : options.chat
      const items = []
      for (const chat of chats.slice(0, limit)) {
        try {
          items.push(await context.withServices((services) => services.metadata.refresh(chat)))
        } catch (error) {
          if (!(error instanceof CliError)) throw error
          items.push({ chatId: chat, error: { code: error.code, message: error.message } })
        }
      }
      renderAnswer(this, context, itemOf(snakeKeys({ chats: items, has_more: chats.length > limit })))
    })
  return command
}
