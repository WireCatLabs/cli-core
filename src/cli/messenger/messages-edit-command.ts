import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { REMOTE_WRITE } from "../effects.js"
import { renderAnswer } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"
import { afterWrite, writtenAnswer } from "./message-writes.js"
import { HTML_HELP } from "./messages-send-command.js"
import { readAll } from "./stdin.js"

export const editCommand = (messenger: Messenger): Command => {
  const edit = annotate(new Command("edit"), {
    examples: [`${messenger.app.command} personal messages edit "Book club" 101 "The meeting starts at 11."`],
    effects: REMOTE_WRITE,
  })
    .description("change the text of your own message; the other side may have read it already")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of your own message")
    .argument("[text]", "the new text; without it, read from stdin")
    .option("--md", "read this messenger's Markdown; see its formatting guide for supported syntax")
    .action(async function (this: Command, chat: string, message: string, text: string | undefined) {
      const context = messengerContext(this, messenger)
      const { md: markdown, html } = this.opts<{ md?: boolean; html?: boolean }>()
      const body = text ?? (await readAll(context.stdin))
      if (body.trim() === "") throw new CliError("validation_error", "no new text — give it or pipe it in")
      const { edited, reader } = await context.withServices(async (services) => {
        const edited = await services.messages.edit({
          chat,
          message: message.trim(),
          text: body,
          markdown: markdown === true,
          ...(html === true ? { html } : {}),
        })
        return afterWrite(edited, async () => ({ edited, reader: await services.messages.reader() }))
      })
      await afterWrite(edited, () => renderAnswer(this, context, writtenAnswer(edited, reader)))
    })
  if (messenger.html) edit.option("--html", HTML_HELP)
  return edit
}
