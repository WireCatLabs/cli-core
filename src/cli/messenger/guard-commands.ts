import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { RecipientList, recipientsPathFor } from "../../sends/recipients.js"
import { positiveCount, renderPage } from "../paging.js"
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
      renderPage({ ...context, settings: { ...settings, all: true } }, { items: chats ?? [], hasMore: false })
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
      context.renderer.result({ id: found.id, title: found.title, added })
    })

  annotate(command.command("remove"), { mutates: true, local: true })
    .argument("<chat>", "chat id, or the title as the list shows it")
    .description("stop allowing this chat; the list stays on")
    .action(async function (this: Command, chat: string) {
      const { settings, renderer, env } = messengerContext(this, messenger)
      const gone = listFor(settings.profile, env).remove(chat)
      if (!gone) throw new CliError("not_found", `${chat.trim()} is not on the recipient list of ${settings.profile}`)
      renderer.result({ id: gone.id, title: gone.title, removed: true })
    })

  annotate(command.command("clear"), { mutates: true, local: true })
    .description("delete the list, which turns it off: this profile may send to any chat again")
    .action(async function (this: Command) {
      const { settings, renderer, env } = messengerContext(this, messenger)
      renderer.result({ off: true, wasOn: listFor(settings.profile, env).off() })
    })

  return command
}

/** Every attempt to send from this profile, kept whatever `--record` says. Never the text. */
export const sendsCommand = (messenger: Messenger): Command =>
  new Command("sends").description("every attempt to send from this profile — never the text").addCommand(
    new Command("list")
      .description("attempts to send, newest first: sent, refused, failed, or not known")
      .option("--limit <n>", "how many to show", positiveCount("--limit"))
      .action(async function (this: Command) {
        const context = messengerContext(this, messenger)
        const { settings, renderer, env } = context
        const entries = new SendJournal(sendsPathFor(messenger.app, settings.profile, env)).entries().reverse()
        renderPage(context, { items: entries.slice(0, settings.limit), hasMore: entries.length > settings.limit })
        if (entries.length === 0) renderer.note(`profile ${settings.profile} has not tried to send anything`)
      }),
  )
