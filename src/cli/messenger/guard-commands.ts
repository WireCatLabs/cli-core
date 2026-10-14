import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { RecipientList, recipientsPathFor } from "../../sends/recipients.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { pagedList } from "../list-query.js"
import { withPaging } from "../paging.js"
import { wholeList } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"

/**
 * The chats this profile may send to. Off until the first `add`; `clear` deletes it, which turns it off again. It stops
 * a model that a message talked into writing somewhere, not an agent set on getting around it.
 */
export const recipientsCommand = (messenger: Messenger): Command => {
  const listFor = (profile: string, env: NodeJS.ProcessEnv) =>
    new RecipientList(recipientsPathFor(messenger.app, profile, env), messenger.app.command)

  const command = new Command("recipients").description("the chats this profile may send to, when the list is on")

  command
    .command("list")
    .description("the chats on the list; empty and off until the first add")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const { settings, renderer, env } = context
      const chats = listFor(settings.profile, env).read()
      renderAnswer(this, context, wholeList("recipients list", (chats ?? []).map(snakeKeys)))
      if (!chats) renderer.note("the recipient list is off — this profile may send to any chat")
      else if (chats.length === 0) renderer.note("the recipient list is on and empty — this profile may send nowhere")
    })

  annotate(command.command("add"), { mutates: true, local: true })
    .argument("<chat>", messenger.chatArgument)
    .description("allow sending to this chat; the first add turns the list on")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const found = await context.withMessenger((connection) => connection.resolve(chat))
      const partnerId = messenger.partnerOf?.(found)
      const added = listFor(context.settings.profile, context.env).add({
        id: found.id,
        title: found.title,
        ...(partnerId === undefined ? {} : { partnerId }),
        addedAt: new Date().toISOString(),
      })
      renderAnswer(this, context, itemOf({ id: found.id, title: found.title, added }))
    })

  annotate(command.command("remove"), { mutates: true, local: true })
    .argument("<chat>", "chat id, or the title as the list shows it")
    .description("stop allowing this chat; the list stays on")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { settings, env } = context
      const gone = listFor(settings.profile, env).remove(chat)
      if (!gone) throw new CliError("not_found", `${chat.trim()} is not on the recipient list of ${settings.profile}`)
      renderAnswer(this, context, itemOf({ id: gone.id, title: gone.title, removed: true }))
    })

  annotate(command.command("clear"), { mutates: true, local: true })
    .description("delete the list, which turns it off: this profile may send to any chat again")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const { settings, env } = context
      renderAnswer(this, context, itemOf({ off: true, was_on: listFor(settings.profile, env).off() }))
    })

  return command
}

/** Every attempt to send from this profile, kept whatever `--record` says. Never the text. */
export const sendsCommand = (messenger: Messenger): Command =>
  new Command("sends").description("every attempt to send from this profile — never the text").addCommand(
    withPaging(
      new Command("list").description("attempts to send, newest first: sent, refused, failed, or not known"),
    ).action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const { settings, renderer, env } = context
      const entries = new SendJournal(sendsPathFor(messenger.app, settings.profile, env)).entries().reverse()
      const from = settings.all ? 0 : (settings.page - 1) * settings.limit
      const shown = settings.all ? entries : entries.slice(from, from + settings.limit)
      renderAnswer(
        this,
        context,
        pagedList("sends list", settings, {
          items: shown.map(snakeKeys),
          has_more: from + shown.length < entries.length,
        }),
      )
      if (entries.length === 0) renderer.note(`profile ${settings.profile} has not tried to send anything`)
    }),
  )
