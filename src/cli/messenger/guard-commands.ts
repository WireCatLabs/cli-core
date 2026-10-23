import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { RecipientList, recipientsPathFor } from "../../sends/recipients.js"
import { FETCH, grantsAuthority, LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { pagedList, typedQuery, withQuery } from "../list-query.js"
import { withPaging } from "../paging.js"
import { wholeList } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"
import { RECIPIENTS_QUERY, recipientFilter } from "./recipients-query.js"
import { SENDS_QUERY, sendFilter } from "./sends-query.js"

/**
 * The chats this profile may send to. Off until the first `add`; `clear` deletes it, which turns it off again. It stops
 * a model that a message talked into writing somewhere, not an agent set on getting around it.
 */
export const recipientsCommand = (messenger: Messenger): Command => {
  const tool = `${messenger.app.command} personal`
  const listFor = (profile: string, env: NodeJS.ProcessEnv) =>
    new RecipientList(recipientsPathFor(messenger.app, profile, env), messenger.app.command)

  const command = new Command("recipients").description("the chats this profile may send to, when the list is on")

  withQuery(
    annotate(command.command("list"), { examples: [`${tool} recipients list`], effects: LOCAL_READ }),
    RECIPIENTS_QUERY,
  )
    .description("the chats on the list; empty and off until the first add")
    .action(async function (this: Command, words: string[]) {
      const filter = recipientFilter(words)
      const context = messengerContext(this, messenger)
      const { settings, renderer, env } = context
      const found = listFor(settings.profile, env).list(filter)
      renderAnswer(this, context, wholeList("recipients list", found.items.map(snakeKeys)))
      if (found.state === "off") renderer.note("the recipient list is off — this profile may send to any chat")
      else if (found.state === "empty")
        renderer.note("the recipient list is on and empty — this profile may send nowhere")
      else if (found.items.length === 0) renderer.note("no recipients match the query")
    })

  grantsAuthority(
    annotate(command.command("add"), {
      examples: [`${tool} recipients add "Book club"`],
      effects: FETCH,
      output: { entity: "recipient_change", view: "added" },
    }),
  )
    .argument("<chat>", messenger.chatArgument)
    .description("allow sending to this chat; the first add turns the list on")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const found = await context.withMessenger((connection) => connection.resolve(chat))
      const partnerId = messenger.partnerOf?.(found)
      const added = await listFor(context.settings.profile, context.env).addAsync({
        id: found.id,
        title: found.title,
        ...(partnerId === undefined ? {} : { partnerId }),
        addedAt: new Date().toISOString(),
      })
      renderAnswer(this, context, itemOf({ id: found.id, title: found.title, added }))
    })

  grantsAuthority(
    annotate(command.command("remove"), {
      examples: [`${tool} recipients remove "Book club"`],
      effects: LOCAL_WRITE,
      output: { entity: "recipient_change", view: "removed" },
    }),
  )
    .argument("<chat>", "chat id, or the title as the list shows it")
    .description("stop allowing this chat; the list stays on")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { settings, env } = context
      const gone = listFor(settings.profile, env).remove(chat)
      if (!gone) throw new CliError("not_found", `${chat.trim()} is not on the recipient list of ${settings.profile}`)
      renderAnswer(this, context, itemOf({ id: gone.id, title: gone.title, removed: true }))
    })

  grantsAuthority(
    annotate(command.command("clear"), {
      examples: [`${tool} recipients clear`],
      effects: LOCAL_WRITE,
      output: { entity: "recipient_change", view: "off" },
    }),
  )
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
    withQuery(
      withPaging(
        annotate(new Command("list"), {
          effects: LOCAL_READ,
          examples: [`${messenger.app.command} personal sends list --limit 10`],
        }).description("attempts to send, newest first: sent, refused, failed, or not known"),
      ),
      SENDS_QUERY,
    ).action(async function (this: Command, words: string[]) {
      const filter = sendFilter(words)
      const context = messengerContext(this, messenger)
      const { settings, renderer, env } = context
      const entries = new SendJournal(sendsPathFor(messenger.app, settings.profile, env)).entries(filter).reverse()
      const from = settings.all ? 0 : (settings.page - 1) * settings.limit
      const shown = settings.all ? entries : entries.slice(from, from + settings.limit)
      renderAnswer(
        this,
        context,
        pagedList("sends list", settings, {
          items: shown.map(snakeKeys),
          args: words.length ? { query: typedQuery(words) } : {},
          has_more: from + shown.length < entries.length,
        }),
      )
      if (entries.length === 0)
        renderer.note(
          filter ? "no send attempts match the query" : `profile ${settings.profile} has not tried to send anything`,
        )
    }),
  )
